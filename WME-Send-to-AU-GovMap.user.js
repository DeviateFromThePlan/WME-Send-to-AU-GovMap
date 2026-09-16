// ==UserScript==
// @name         WME Send to AU GovMap
// @namespace    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap
// @version      2026.09.16.01
// @description  Opens your government's map to the coordinates currently in WME.
// @author       DeviateFromThePlan, maporaptor & lacmacca
// @license      MIT
// @match        *://*.waze.com/*editor*
// @match        *://*.qldglobe.information.qld.gov.au/*
// @match        *://*.nrmaps.nt.gov.au/nrmaps.htm*
// @exclude      *://*.waze.com/user/editor*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.7.5/proj4.js
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @homepage     https://www.waze.com/discuss/t/340375
// @downloadURL  https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases/latest/download/WME-Send-to-AU-GovMap.user.js
// @updateURL    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases/latest/download/WME-Send-to-AU-GovMap.user.js
// @supportURL   https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/issues/new/choose
// @iconURL      https://i.ibb.co/k8RdMh0/image.png
// ==/UserScript==

/* global WazeWrap, proj4, getWmeSdk, GM_info */

(function () {
    'use strict';

    const ScriptName = GM_info.script.name;
    const ScriptVersion = GM_info.script.version;
    const BUTTON_ID = 'WME-showState';
    const DEFAULT_TIMEOUT_MS = 20000;

    function log(...parts) {
        console.log(`${ScriptName}:`, ...parts);
    }

    // ------------------------------------------------------------------
    //  Shared DOM helpers
    // ------------------------------------------------------------------

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * Resolves with the first truthy value returned by `probe`.
     * Uses a MutationObserver so it reacts immediately, with a slow interval as
     * a backstop for changes the observer cannot see (e.g. pure style updates).
     * Observer callbacks are coalesced to one probe per animation frame: map
     * pages mutate constantly, and probing (which measures layout) on every
     * mutation slows the page down.
     */
    function waitUntil(probe, { timeout = DEFAULT_TIMEOUT_MS, label = 'condition' } = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let frameQueued = false;

            const cleanup = () => {
                observer.disconnect();
                clearInterval(ticker);
                clearTimeout(timer);
            };

            const attempt = () => {
                if (settled) return true;
                let value = null;
                try {
                    value = probe();
                } catch (err) {
                    value = null;
                }
                if (value) {
                    settled = true;
                    cleanup();
                    resolve(value);
                    return true;
                }
                return false;
            };

            const observer = new MutationObserver(() => {
                if (frameQueued || settled) return;
                frameQueued = true;
                requestAnimationFrame(() => {
                    frameQueued = false;
                    attempt();
                });
            });
            const ticker = setInterval(attempt, 250);
            const timer = setTimeout(() => {
                settled = true;
                cleanup();
                reject(new Error(`timed out waiting for ${label}`));
            }, timeout);

            if (!attempt()) {
                observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            }
        });
    }

    /**
     * Waits for an element. `selectors` is tried in the order given, so the
     * first *selector* wins - unlike `querySelector('a, b')`, which returns
     * whichever match happens to come first in document order.
     */
    function waitFor(selectors, { visible = false, ...opts } = {}) {
        const list = Array.isArray(selectors) ? selectors : [selectors];
        const probe = () => {
            for (const selector of list) {
                if (visible) {
                    for (const el of document.querySelectorAll(selector)) {
                        if (isVisible(el)) return el;
                    }
                } else {
                    const el = document.querySelector(selector);
                    if (el) return el;
                }
            }
            return null;
        };
        return waitUntil(probe, { label: list.join(' | '), ...opts });
    }

    /** Same as waitFor, but resolves to null instead of throwing on timeout. */
    const waitForOptional = (selectors, opts) => waitFor(selectors, opts).catch(() => null);

    /**
     * Finds the innermost element whose trimmed text matches. Matching on
     * `textContent` alone would also match every wrapper around the real
     * control, and clicking a wrapper usually does nothing.
     */
    function findByText(selectors, needle, { exact = true } = {}) {
        const wanted = needle.trim().toUpperCase();
        for (const selector of selectors) {
            const matches = Array.from(document.querySelectorAll(selector)).filter((el) => {
                const text = (el.textContent || '').trim().toUpperCase();
                return exact ? text === wanted : text.includes(wanted);
            });
            const innermost = matches.find((el) => !matches.some((other) => other !== el && el.contains(other)));
            if (innermost) return innermost;
        }
        return null;
    }

    /**
     * Sets an input's value through the native setter so frameworks that patch
     * the value property (React and friends) still see the change.
     */
    function setInputValue(el, value, { blur = false } = {}) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // ExtJS text fields read their value on blur.
        if (blur) el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    /**
     * Picks an option in an ExtJS combo. Setting .value is not enough: the
     * component keeps its own value and only updates it when a list item is
     * chosen, so the form still submits the old selection.
     */
    async function selectExtComboOption(input, matcher) {
        const wrap = input.parentElement;
        const trigger = wrap && wrap.querySelector('.x-form-trigger');
        if (!trigger) throw new Error('combo has no trigger');
        trigger.click();

        const item = await waitUntil(() => {
            const list = [...document.querySelectorAll('.x-combo-list')].find((l) => isVisible(l));
            if (!list) return null;
            return [...list.querySelectorAll('.x-combo-list-item')].find((i) => matcher(i.textContent.trim())) || null;
        }, { timeout: 8000, label: 'a combo option' });

        item.click();
        await sleep(300);
    }

    function pressEnter(el) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
            el.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
            }));
        }
    }

    /** Parses a "lat,lon" string. Returns null if it is missing or malformed. */
    function parseLatLon(value) {
        if (!value) return null;
        const parts = String(value).split(',');
        if (parts.length !== 2) return null;
        const lat = parseFloat(parts[0]);
        const lon = parseFloat(parts[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon };
    }

    function getHashParams() {
        const params = new URLSearchParams(window.location.hash.substring(1));
        return { center: params.get('center'), scale: params.get('scale') };
    }

    function onDocumentReady(fn) {
        if (document.readyState === 'complete') {
            fn();
        } else {
            window.addEventListener('load', fn, { once: true });
        }
    }

    // ------------------------------------------------------------------
    //  Waze Map Editor
    // ------------------------------------------------------------------

    const WGS_84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs';
    const VIC_GRID_94 = '+proj=tmerc +lat_0=-37 +lon_0=145 +k=1 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs';

    // WME zoom levels run 12 (whole state) to 22 (house level).
    const WME_ZOOM_MIN = 12;
    const WME_ZOOM_MAX = 22;

    // MapShare Vic's basemap cache has 14 levels (8000016 down to 976.56);
    // anything past the last one renders blank, hence the clamp.
    const VIC_SCALE_MAX = 8000016.000032;
    const VIC_SCALE_MIN = 976.5644531289063;
    const VIC_SCALE_BASE_ZOOM = 6;

    // Web Mercator scale denominator at zoom 20, used by QLD Globe and NR Maps.
    const SCALE_AT_ZOOM_20 = 564;

    const TAS_TOPO = 'https://services.thelist.tas.gov.au/arcgis/rest/services/Public/TopographyAndRelief/MapServer/7';
    const WA_ROAD_ASSETS = 'https://gisservices.mainroads.wa.gov.au/arcgis/rest/services/OpenData/RoadAssets_DataPortal/MapServer';

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const webMercatorScale = (zoom) => Math.round(SCALE_AT_ZOOM_20 * Math.pow(2, 20 - zoom));

    /**
     * Builds a query string with the values left raw. Several of these viewers
     * take whole service URLs as parameters and are known to work with them
     * unencoded, so percent-encoding would be a needless change. Params with an
     * empty value are dropped rather than sent as "z=null".
     */
    function buildQuery(params) {
        return Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${value}`)
            .join('&');
    }

    function buildUrl(base, params) {
        const query = buildQuery(params);
        return query ? `${base}?${query}` : base;
    }

    const arcgisViewerUrl = (params) => buildUrl('https://www.arcgis.com/apps/mapviewer/index.html', params);

    // Each entry takes {lat, lon, zoom} and returns the URL to open.
    const STATE_MAPS = {
        'Victoria': ({ lat, lon, zoom }) => {
            const [x, y] = proj4(WGS_84, VIC_GRID_94, [lon, lat]);
            const scale = clamp(VIC_SCALE_MAX / Math.pow(2, zoom - VIC_SCALE_BASE_ZOOM), VIC_SCALE_MIN, VIC_SCALE_MAX);
            return buildUrl('https://mapshare.vic.gov.au/mapsharevic/', { scale, center: `${x},${y}` });
        },

        'South Australia': ({ lat, lon, zoom }) => buildUrl('https://location.sa.gov.au/viewer/', {
            map: 'hybrid',
            x: lon,
            y: lat,
            z: zoom,
            uids: '135,136',
        }),

        'New South Wales': ({ lat, lon, zoom }) => arcgisViewerUrl({
            // https, not http - arcgis.com is https and blocks mixed content.
            basemapUrl: 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Base_Map/MapServer',
            center: `${lon},${lat}`,
            level: Math.min(zoom, 21), // the SIX basemap cache only has levels 0-21
        }),

        'Tasmania': ({ lat, lon, zoom }) => arcgisViewerUrl({
            basemapUrl: 'https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/SimpleBasemap/MapServer',
            basemapReferenceUrl: TAS_TOPO,
            url: TAS_TOPO,
            center: `${lon},${lat}`,
            level: Math.min(zoom, 18), // the LIST basemap tops out at level 18
        }),

        // No basemapUrl here on purpose. The Main Roads service is a dynamic
        // service (singleFusedMapCache: false, no tileInfo, GDA94) - as a
        // basemap it gives the viewer no tiling scheme, so `level` has no LODs
        // to resolve against and the zoom is silently ignored. Left as an
        // operational layer over the default (tiled) basemap, `level` works.
        'Western Australia': ({ lat, lon, zoom }) => arcgisViewerUrl({
            url: `${WA_ROAD_ASSETS}/17`, // 17 = Road Network
            center: `${lon},${lat}`,
            level: zoom,
        }),

        'Australian Capital Territory': ({ lat, lon, zoom }) => buildUrl(
            'https://actmapi-actgov.opendata.arcgis.com/datasets/actgov-road-centrelines/explore',
            { location: `${lat},${lon},${zoom}` },
        ),

        'Queensland': ({ lat, lon, zoom }) => buildUrl('https://qldglobe.information.qld.gov.au/', {
            center: `${lat.toFixed(5)},${lon.toFixed(5)}`,
            scale: webMercatorScale(zoom),
        }),

        'Northern Territory': ({ lat, lon, zoom }) => {
            const hash = buildQuery({
                center: `${lat.toFixed(5)},${lon.toFixed(5)}`,
                scale: webMercatorScale(zoom),
            });
            return `https://nrmaps.nt.gov.au/nrmaps.htm#${hash}`;
        },
    };

    const RELEASE_NOTES = '<br><a href="https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases" target="_blank"><img src="https://simpleicons.org/icons/github.svg" width=10> View Release Notes</a>';
    const UPDATE_NOTES = [
        '<h4><u>Fixes:</u></h4><ul>',
        '<li>NT: NR Maps now moves and zooms to the right place again. It drives the Coordinate Zoom tool and the map scale box directly, and no longer depends on the internal ExtJS element ids, which had shifted and broken it.</li>',
        '<li>WA: the map now opens at the correct zoom. The Main Roads service has no tile cache, so using it as the base map left the viewer with no zoom levels to work with; the road network is now drawn over the standard base map instead.</li>',
        '<li>QLD Globe: much faster, and it now opens at the same zoom as WME. Each step waits for the page instead of sitting out fixed delays, and the zoom is no longer undone by QLD Globe zooming to the search result.</li>',
        '<li>NSW: the base map is now loaded over https so it is no longer blocked as mixed content, and the zoom is capped at the level the SIX cache actually provides.</li>',
        '<li>The button no longer throws an error when the map centre is over water, and no longer goes missing when WME opens outside Australia.</li>',
        '</ul>',
    ].join('');

    let wmeSDK;
    let initialised = false;

    const warn = (message) => WazeWrap.Alerts.warning(ScriptName, message);

    function getMapLink(event) {
        if (event) event.preventDefault();

        // Both getters return null when the map centre is over water, so check
        // for that before reading .name - and before the country check, or open
        // ocean gets reported as an unsupported country.
        const country = wmeSDK.DataModel.Countries.getTopCountry();
        const state = wmeSDK.DataModel.States.getTopState();
        if (!country || !state || !state.name) {
            warn('Please move closer to land.');
            return false;
        }

        if (country.name !== 'Australia') {
            warn("Sorry but we currently don't support loading maps from other countries but Australia.");
            return false;
        }

        const buildStateUrl = STATE_MAPS[state.name];
        if (!buildStateUrl) {
            warn(`Sorry but we currently don't support loading maps from ${state.name}.`);
            return false;
        }

        const center = wmeSDK.Map.getMapCenter();
        if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
            warn('Could not read the current map position. Try panning the map and clicking again.');
            return false;
        }

        const zoom = clamp(wmeSDK.Map.getZoomLevel(), WME_ZOOM_MIN, WME_ZOOM_MAX);

        let url;
        try {
            url = buildStateUrl({ lat: center.lat, lon: center.lon, zoom });
        } catch (err) {
            log('Failed to build the map URL:', err);
            warn('Something went wrong building the map link - see the browser console for details.');
            return false;
        }

        log(`Opening ${state.name}: ${url}`);
        if (!window.open(url, '_blank')) {
            warn('Your browser blocked the new tab. Allow pop-ups for waze.com and try again.');
        }
        return false;
    }

    async function addFooterButton() {
        if (document.getElementById(BUTTON_ID)) return;

        const mousePosition = await waitForOptional('.wz-map-ol-control-mouse-position', { timeout: 30000 });
        if (!mousePosition || !mousePosition.parentNode) {
            log('Could not find the WME footer, so the GovMap button was not added.');
            return;
        }
        if (document.getElementById(BUTTON_ID)) return;

        const link = document.createElement('a');
        link.id = BUTTON_ID;
        link.classList.add('wz-map-black-link');
        link.innerText = '🇦🇺 GovMap';
        link.title = 'Open this location in your state government map';
        link.style.cursor = 'pointer';
        link.tabIndex = 0;
        link.addEventListener('click', getMapLink);
        link.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') getMapLink(event);
        });

        mousePosition.parentNode.insertBefore(link, mousePosition.nextSibling);
    }

    function initWME() {
        if (initialised) return;
        initialised = true;
        log('Start');

        WazeWrap.Interface.ShowScriptUpdate(ScriptName, ScriptVersion, UPDATE_NOTES + RELEASE_NOTES, '');
        addFooterButton();

        log('Done');
    }

    function bootstrapWME() {
        if (typeof WazeWrap === 'undefined' || !WazeWrap.Ready || !WazeWrap.Interface) {
            setTimeout(bootstrapWME, 250);
            return;
        }
        if (wmeSDK.State.isReady) {
            initWME();
        } else {
            wmeSDK.Events.once({ eventName: 'wme-ready' }).then(initWME);
        }
    }

    function startWME() {
        if (!window.SDK_INITIALIZED) {
            log('WME SDK not found on this page - nothing to do.');
            return;
        }
        window.SDK_INITIALIZED.then(() => {
            wmeSDK = getWmeSdk({ scriptId: 'wme-send-to-AU-GovMap', scriptName: 'Send to AU GovMap' });
            bootstrapWME();
        });
    }

    // ------------------------------------------------------------------
    //  QLD Globe automation
    // ------------------------------------------------------------------

    /**
     * Finds QLD Globe's main Esri MapView by walking the app object instead of
     * relying on a fixed property path. The page has two MapViews (the main map
     * and the overview map); the main one has the largest container. Returns
     * null if the page's internals no longer look like this.
     */
    function findQLDMapView() {
        const views = [];
        const seen = new WeakSet();
        (function walk(obj, depth) {
            if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 5) return;
            seen.add(obj);
            try {
                if (obj.declaredClass === 'esri.views.MapView') {
                    views.push(obj);
                    return;
                }
            } catch (err) {
                return;
            }
            let keys;
            try {
                keys = Object.keys(obj);
            } catch (err) {
                return;
            }
            for (const key of keys) {
                let value;
                try {
                    value = obj[key];
                } catch (err) {
                    continue;
                }
                if (value && typeof value === 'object' && !(value instanceof Node)) walk(value, depth + 1);
            }
        })(window.app, 0);

        const area = (view) => {
            const rect = view.container && view.container.getBoundingClientRect && view.container.getBoundingClientRect();
            return rect ? rect.width * rect.height : 0;
        };
        return views.sort((a, b) => area(b) - area(a))[0] || null;
    }

    /**
     * Keeps the map at the WME scale for a few seconds after we set it.
     *
     * QLD Globe can re-zoom the map on its own after we have moved it: the
     * search's zoom-to-result (which pads a point out to a minimum extent,
     * roughly 1:10000) can land after ours if the two start within a few ms,
     * and the view setup re-syncs the view a few seconds after load. Whenever
     * the scale drifts, move it back. Stops as soon as the user touches the map
     * so it never fights them.
     */
    function holdQLDView(view, scale, goThere, { holdMs = 6000 } = {}) {
        const userEvents = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
        const container = view.container;
        let stopped = false;
        let pending = false;

        const stop = () => {
            if (stopped) return;
            stopped = true;
            clearInterval(ticker);
            clearTimeout(timer);
            if (container) userEvents.forEach((type) => container.removeEventListener(type, stop, true));
        };

        const check = () => {
            if (stopped || pending) return;
            if (Math.abs(Math.log(view.scale / scale)) < 0.02) return;
            pending = true;
            log(`QLD Globe: the page re-zoomed the map to 1:${Math.round(view.scale)}, putting it back.`);
            goThere().catch(() => {}).then(() => {
                pending = false;
            });
        };

        if (container) userEvents.forEach((type) => container.addEventListener(type, stop, true));
        const ticker = setInterval(check, 100);
        const timer = setTimeout(stop, holdMs);
        check();
    }

    /**
     * Moves the map to the target at the WME scale.
     *
     * Submitting a search starts QLD Globe's own zoom to the result, and
     * setting the scale box while that runs gets overwritten, which is why the
     * map landed on the right spot at the wrong zoom. A non-animated goTo on the
     * map view interrupts that zoom and applies centre and scale in one step,
     * then holdQLDView keeps it there. If the map view can't be found, fall
     * back to the scale box, but only after the page's own zoom has finished.
     */
    async function applyQLDScale(coords, scale, scaleBefore) {
        const view = findQLDMapView();
        if (view && typeof view.goTo === 'function') {
            const goThere = () => view.goTo({ center: [coords.lon, coords.lat], scale }, { animate: false })
                .catch((err) => {
                    if (err.name !== 'view:goto-interrupted') throw err;
                });
            try {
                await goThere();
                holdQLDView(view, scale, goThere);
                return;
            } catch (err) {
                log(`QLD Globe: could not move the map directly (${err.message}), using the scale box instead.`);
            }
        }

        const scaleInput = await waitFor('#scale-control input', { timeout: 5000 });

        // The box shows a new value once the fly-to lands; wait for that, then
        // for it to stop changing, before typing ours in.
        await waitUntil(() => scaleInput.value !== scaleBefore, { timeout: 8000, label: 'the search to finish zooming' })
            .catch(() => {});
        let last = scaleInput.value;
        let changedAt = Date.now();
        await waitUntil(() => {
            if (scaleInput.value !== last) {
                last = scaleInput.value;
                changedAt = Date.now();
            }
            return Date.now() - changedAt >= 300;
        }, { timeout: 5000, label: 'the map to settle' }).catch(() => {});

        setInputValue(scaleInput, scale);
        pressEnter(scaleInput);
    }

    async function runAutomationQLD() {
        const params = new URLSearchParams(window.location.search);
        const coords = parseLatLon(params.get('center'));
        const scale = params.get('scale');

        if (!coords) {
            log('QLD Globe: no coordinates in the URL, nothing to automate.');
            return;
        }
        const target = `${coords.lat.toFixed(5)},${coords.lon.toFixed(5)}`;

        // Every wait below is for something that is guaranteed to turn up. The
        // earlier version also waited for things that may never happen - the
        // splash appearing, the splash disappearing, a fixed pause before the
        // scale - and each of those sat out its full timeout, which is what
        // made it slow.
        try {
            // 1. Wait for the sidebar. The terms splash renders in the same pass,
            //    so once the sidebar is there the splash is either showing or
            //    not coming.
            const searchToggle = await waitFor([
                "a[href='#sidebar-search']",
                "a[aria-controls='sidebar-search']",
                'li.contains-icon-search a',
            ], { visible: true });

            // 2. Dismiss the splash if it is up. Do not wait for it to go away:
            //    its markup stays in the page at full size after it is
            //    dismissed, so a "wait until hidden" check never passes.
            const readCheck = document.querySelector('.read-check');
            if (isVisible(readCheck)) readCheck.click();
            const getStarted = findByText(['a', 'button'], 'GET STARTED');
            if (isVisible(getStarted)) getStarted.click();

            // 3. Open search and pick the lat/long mode, matched on its label
            //    ("Latitude and Longitude") with the old positional selector as
            //    a fallback.
            searchToggle.click();
            const coordinateMode = await waitUntil(() => {
                const items = [...document.querySelectorAll('#sidebar-search li')].filter(isVisible);
                return items.find((li) => /latitude/i.test(li.textContent))
                    || (items.length ? document.querySelector('#sidebar-search li:nth-of-type(6)') : null);
            }, { timeout: 10000, label: 'the Latitude and Longitude search option' });
            coordinateMode.click();

            // 4. Enter the coordinates and submit.
            const input = await waitFor(
                ['#sidebar-search input[type="text"]', '#sidebar-search input'],
                { timeout: 10000, visible: true },
            );
            setInputValue(input, target);

            const scaleBox = document.querySelector('#scale-control input');
            const scaleBefore = scaleBox ? scaleBox.value : null;

            const submit = document.querySelector('#sidebar-search div.form i')
                || document.querySelector('div.form i');
            if (isVisible(submit)) {
                submit.click();
            } else {
                pressEnter(input);
            }

            // 5. Match the WME zoom once the search has placed its result, so the
            //    search's own zoom can't land on top of ours.
            if (scale) {
                await waitUntil(
                    () => [...document.querySelectorAll('#sidebar-search .search-results li')]
                        .find((li) => isVisible(li) && li.textContent.includes(target)) || null,
                    { timeout: 8000, label: 'the search result' },
                ).catch(() => log('QLD Globe: no search result showed, setting the scale anyway.'));
                await applyQLDScale(coords, Math.round(Number(scale)), scaleBefore);
            }

            log('QLD Globe: done.');
        } catch (err) {
            log(`QLD Globe automation stopped: ${err.message}`);
        }
    }

    // ------------------------------------------------------------------
    //  NR Maps (NT) automation
    // ------------------------------------------------------------------

    // Nothing here keys off the ext-gen*/ext-comp-* ids. Those are assigned in
    // component creation order and shift whenever NR Maps is rebuilt, which is
    // what broke the previous version. The anchors used instead - the
    // .icon-coordzoom toolbar class, the lat-deg/lon-deg field names, the
    // <label for> pairings and the button captions - are all authored markup.

    /** The Coordinate Zoom dialog only offers these three widths. */
    function ntZoomWidth(zoom) {
        if (zoom >= 16) return /^1 Kilometre/i;
        if (zoom >= 14) return /^10 Kilometres/i;
        return /^25 Kilometres/i;
    }

    /** The map scale box sits in the toolbar under the map, next to "Scale 1:". */
    function findNTScaleInput() {
        const label = [...document.querySelectorAll('.xtb-text, div, span, label')]
            .find((el) => el.children.length === 0 && /^scale\s*1:\s*$/i.test((el.textContent || '').trim()));
        if (!label) return null;
        const row = label.closest('tr') || label.parentElement;
        const cells = [...row.children];
        for (let i = cells.findIndex((c) => c.contains(label)); i >= 0 && i < cells.length; i++) {
            const input = cells[i].querySelector('input');
            if (input) return input;
        }
        return null;
    }

    async function runAutomationNT() {
        const { center, scale } = getHashParams();
        const coords = parseLatLon(center);
        if (!coords) {
            log('NR Maps: no coordinates in the URL, nothing to automate.');
            return;
        }
        const zoom = scale ? Math.round(20 - Math.log2(Number(scale) / SCALE_AT_ZOOM_20)) : 17;

        try {
            // 1. Open the "Coordinate Zoom" tool from the map toolbar.
            (await waitFor('button.icon-coordzoom', { visible: true })).click();

            const dialog = await waitUntil(
                () => [...document.querySelectorAll('.x-window')]
                    .find((w) => isVisible(w) && /Coordinate Zoom/i.test(w.textContent)) || null,
                { label: 'the Coordinate Zoom dialog' },
            );

            const labelledInput = (pattern) => {
                const label = [...dialog.querySelectorAll('label')].find((l) => pattern.test(l.textContent));
                return label ? document.getElementById(label.htmlFor) : null;
            };

            // 2. The lat/lon fields only exist while the decimal-degrees
            //    projection is selected, so make sure that is the one showing.
            const projection = labelledInput(/select projection/i);
            if (projection && !/GDA94.*DD/i.test(projection.value)) {
                await selectExtComboOption(projection, (text) => /GDA94.*\(DD\)/i.test(text));
            }

            // 3. Fill in the coordinates. Each name appears twice (the DMS panel
            //    keeps a hidden copy), so take the visible one.
            const visibleByName = (name) => waitUntil(
                () => [...dialog.querySelectorAll(`input[name="${name}"]`)].find(isVisible) || null,
                { label: `the ${name} field` },
            );
            setInputValue(await visibleByName('lat-deg'), coords.lat, { blur: true });
            setInputValue(await visibleByName('lon-deg'), coords.lon, { blur: true });

            // 4. Pick a zoom width. Only 1/10/25 km are on offer, so this is just
            //    a sane starting extent - step 6 sets the real scale.
            const widthCombo = labelledInput(/zoom width/i);
            if (widthCombo) {
                const wanted = ntZoomWidth(zoom);
                await selectExtComboOption(widthCombo, (text) => wanted.test(text));
            }

            // 5. Zoom, then close the dialog so it stops covering the map.
            const button = (caption) => [...dialog.querySelectorAll('button')]
                .find((b) => b.textContent.trim().toLowerCase() === caption);

            const zoomButton = button('zoom');
            if (!zoomButton) throw new Error('the Zoom button is missing');
            zoomButton.click();
            await sleep(2000);

            const closeButton = button('close');
            if (closeButton) closeButton.click();

            // 6. Match the WME zoom exactly via the scale box under the map.
            if (scale) {
                const scaleInput = await waitUntil(findNTScaleInput, { label: 'the map scale box' });
                scaleInput.focus();
                setInputValue(scaleInput, Math.round(Number(scale)), { blur: false });
                pressEnter(scaleInput);
            }

            log('NR Maps: done.');
        } catch (err) {
            log(`NR Maps automation stopped: ${err.message}`);
        }
    }

    // ------------------------------------------------------------------
    //  Entry point
    // ------------------------------------------------------------------

    const host = window.location.hostname;

    if (host === 'www.waze.com' || host === 'beta.waze.com') {
        startWME();
    } else if (host.endsWith('qldglobe.information.qld.gov.au')) {
        log('Detected Queensland Globe page.');
        onDocumentReady(runAutomationQLD);
    } else if (host.endsWith('nrmaps.nt.gov.au')) {
        log('Detected NR Maps page.');
        onDocumentReady(runAutomationNT);
    }
})();
