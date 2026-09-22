// ==UserScript==
// @name         WME Send to AU GovMap
// @namespace    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap
// @version      2026.09.22.02
// @description  Opens your government's map to the coordinates currently in WME.
// @author       DeviateFromThePlan, maporaptor & lacmacca
// @license      MIT
// @match        *://*.waze.com/*editor*
// @match        *://*.qldglobe.information.qld.gov.au/*
// @match        *://*.nrmaps.nt.gov.au/nrmaps.htm*
// @match        *://mapshare.vic.gov.au/mapsharevic*
// @match        *://location.sa.gov.au/viewer*
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

/* global WazeWrap, proj4, getWmeSdk */

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
    //  Allowed-layers views (shared by the government map pages)
    // ------------------------------------------------------------------

    const GUIDE_URL = 'https://www.waze.com/discuss/t/375455';
    const GUIDE_LINK = `<a href="${GUIDE_URL}" target="_blank" rel="noopener" style="color:inherit">AU third-party data guide</a>`;
    const NOTE_STYLE = 'margin:6px;padding:6px 8px;border:1px solid #9bb7d6;background:#eef4fb;color:#1b3a5c;'
        + 'font:12px/1.4 Arial,Helvetica,sans-serif;text-align:left;';

    function readShowAll(key) {
        try {
            return window.localStorage.getItem(key) === '1';
        } catch (err) {
            return false;
        }
    }

    function saveShowAll(key, showAll) {
        try {
            window.localStorage.setItem(key, showAll ? '1' : '0');
        } catch (err) {
            // Storage blocked - the choice just won't be remembered.
        }
    }

    /**
     * The "only allowed layers are shown" note with its "Show all layers"
     * toggle, remembered per site. Its clicks are kept from reaching the page
     * underneath, since layer lists tend to treat any click as their own.
     */
    function createAllowedLayersNote({ id, message, storageKey, onToggle, style = NOTE_STYLE }) {
        const note = document.createElement('div');
        note.id = id;
        note.style.cssText = style;
        const sentence = message.charAt(0).toUpperCase() + message.slice(1);
        note.innerHTML = `<b>WME GovMap:</b> ${sentence}`
            + '<label style="display:block;margin-top:4px;cursor:pointer;font-weight:normal">'
            + '<input type="checkbox" style="vertical-align:middle;margin:0 4px 0 0">Show all layers</label>';
        const toggle = note.querySelector('input');
        toggle.checked = readShowAll(storageKey);
        toggle.addEventListener('change', () => {
            saveShowAll(storageKey, toggle.checked);
            onToggle(toggle.checked);
        });
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown']) {
            note.addEventListener(type, (event) => event.stopPropagation());
        }
        return note;
    }

    /**
     * Runs `callback` (batched, shortly after) whenever elements are added or
     * removed under `target` - for pages that redraw their layer lists.
     * Only child-list changes are watched, so the callback hiding or showing
     * things can't trigger itself. Batched with a timer rather than an
     * animation frame, since these pages often open in a background tab,
     * where animation frames are paused.
     */
    function onDomChange(target, callback) {
        let queued = false;
        const observer = new MutationObserver(() => {
            if (queued) return;
            queued = true;
            setTimeout(() => {
                queued = false;
                callback();
            }, 50);
        });
        observer.observe(target, { childList: true, subtree: true });
        return observer;
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

    // MapShare's own encoding of a layer set (basemap plus the Vicmap
    // Transport road and rail labels), copied from a MapShare share link. It is
    // already URL-encoded, so it must go into the URL as-is.
    const VIC_LAYERS = '3uXnvq2%2F7Gju1qBv%2BE1exh5B2QyE7X2NZLPj1qBv%2BE1exh5B2QyE7X1a%2BrRU3AktiU2j%2B9SY3nLu6D0poVnv0B8V8Z0nXUfb2808eE134Cfv1VC8SV30xOvX0XLQlK2apKdj1L5pnF1W2RMs1ANy%2BH3XikB50APgsK3pjUpZ3QwvSd2h3lEc0ocvat3AXBwk1dLxeM1Ynb9f19NEQ03Mkart0OgpII2AAqMk1%2F7fnZ2SSAmV2dVLLg29THcp0esJt%2B3uMwRb2TrpCK1Bcish3Mx7TY1G%2BZsm02oG%2F11MMMvH1qudLY1qy8pc3B5WKq1KMHS42KTwsK2g5CGb2t%2BJ931Bsloz0YFTf02Zt2Hh1CbU%2FB3S%2BNWC3T1u%2BD1nlgj30eqOPw3ZK6Qz0eKbZP1CcYxN2k2fBh3bvmsT1Pocd13MqwBP2FfPi62LopjD22G3%2Fq2ItfM72%2Fqiyk1di4QS0r76d50H35E51HhN5T35e37h3kPWGd03Tvip3kPW1a3kPVoY0SVzxl1XAOMo21DDRP0YBDmm1qhwxc';

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
            return buildUrl('https://mapshare.vic.gov.au/mapsharevic/', { scale, center: `${x},${y}`, layers: VIC_LAYERS });
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
        '<h4><u>New features:</u></h4><ul>',
        '<li>NT: NR Maps now opens with the layers recommended in the AU third-party data guide switched on (General Text, Place Names and Localities are added) and the Coastline basemap instead of Google Maps.</li>',
        '<li>NT: the NR Maps layer list now only shows the layers Waze editors are allowed to use.</li>',
        '<li>QLD: layers Waze can\'t use are hidden and switched off - satellite imagery, tourism data, postcode and federal electoral boundaries, and other organisations\' data (NSW, Native Title Tribunal, NHVR, Energy Queensland, Esri). The Imagery basemap stays on for getting your bearings only.</li>',
        '<li>VIC: MapShare\'s contour and Crown Parcel layers are hidden and switched off - they aren\'t under a Creative Commons licence.</li>',
        '<li>SA: Location SA Viewer only shows the Roads and Road Route Numbers datasets and the Satellite map.</li>',
        '<li>Each of these has a note explaining why, and a "Show all layers" tick box to see everything. Unticking it switches the hidden layers off again.</li>',
        '</ul>',
    ].join('');

    let wmeSDK;
    let initialised = false;

    const warn = (message) => WazeWrap.Alerts.warning(ScriptName, message);

    /**
     * Click handler for the footer button. Anything that goes wrong is shown to
     * the user as a WazeWrap error rather than only landing in the console,
     * where most editors would never see it.
     */
    function getMapLink(event) {
        if (event) event.preventDefault();
        try {
            openGovMap();
        } catch (err) {
            log('Unexpected error opening the map:', err);
            WazeWrap.Alerts.error(
                ScriptName,
                `Something went wrong opening the government map: ${err && err.message ? err.message : err}`,
            );
        }
        return false;
    }

    function openGovMap() {
        // Both getters return null when the map centre is over water, so check
        // for that before reading .name - and before the country check, or open
        // ocean gets reported as an unsupported country.
        const country = wmeSDK.DataModel.Countries.getTopCountry();
        const state = wmeSDK.DataModel.States.getTopState();
        if (!country || !state || !state.name) {
            warn('Please move closer to land.');
            return;
        }

        if (country.name !== 'Australia') {
            warn("Sorry but we currently don't support loading maps from other countries but Australia.");
            return;
        }

        const buildStateUrl = STATE_MAPS[state.name];
        if (!buildStateUrl) {
            warn(`Sorry but we currently don't support loading maps from ${state.name}.`);
            return;
        }

        const center = wmeSDK.Map.getMapCenter();
        if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
            warn('Could not read the current map position. Try panning the map and clicking again.');
            return;
        }

        const zoom = clamp(wmeSDK.Map.getZoomLevel(), WME_ZOOM_MIN, WME_ZOOM_MAX);
        const url = buildStateUrl({ lat: center.lat, lon: center.lon, zoom });

        log(`Opening ${state.name}: ${url}`);
        if (!window.open(url, '_blank')) {
            warn('Your browser blocked the new tab. Allow pop-ups for waze.com and try again.');
        }
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

    // The layers the AU community's third-party data guide recommends for
    // editing (https://www.waze.com/discuss/t/375455). These are QLD Globe's
    // own layer-list ids.
    const QLD_LAYER_TOC_IDS = [
        'toc-root-location-address', // Location > Address
        'toc-root-boundaries-localbdy', // Boundaries > Locality
        'toc-root-planning-parcels-road', // Planning cadastre > Road parcel
        'toc-root-planning-parcels-base', // Planning cadastre > Land parcel
    ];

    // Layers Waze can't use. QLD Globe's data is Creative Commons except what
    // its Data Licence Conditions page lists as used under licence from other
    // parties (https://qldglobe.information.qld.gov.au/help-info/Specific-data-conditions.html):
    // satellite imagery, tourism data (ATDW), postcode boundaries and
    // Commonwealth electoral boundaries. On top of that, some layers come
    // straight from other organisations' services rather than the State's:
    // NSW Spatial Services (the guide only authorises the NSW Base Map), the
    // National Native Title Tribunal, the NHVR, Energy Queensland (BYDA) and
    // Esri. Matched on the layer's service so new layers in those services are
    // caught too. The "Imagery" basemap (© 21AT, Earth-i, all rights reserved)
    // is deliberately left on, like the other states' basemaps: fine for
    // getting your bearings, never copy from it - the note says so.
    const QLD_EXCLUDED_SERVICES = new RegExp('^('
        + 'LateSat' // Planet satellite imagery, all rights reserved
        + '|Flood\\d' // historic flood imagery (natural disaster imagery includes Planet, all rights reserved)
        + '|atdw' // Australian Tourism Data Warehouse
        + '|nsw' // NSW Spatial Services layers
        + '|nntt' // National Native Title Tribunal
        + '|nhvr' // National Heavy Vehicle Regulator
        + '|byda_' // Energy Queensland network (Before You Dig)
        + '|esriLightGray' // Esri "World basemap grey"
        + ')');
    const QLD_EXCLUDED_IDS = [
        'toc-root-boundaries-postcodes', // PSMA postcode boundaries
        'toc-root-boundaries-electoral-fedelectoral', // Australian Electoral Commission
    ];
    const QLD_EXCLUDED_ID_PREFIXES = ['toc-root-imagery-QSAT']; // Queensland satellite imagery (Planet)
    // Switched on along with the recommended layers - QLD Globe remembers
    // layer choices, so it could otherwise stay off from an earlier visit.
    const QLD_IMAGERY_ID = 'toc-root-imagery-imag';
    const QLD_NOTE_ID = 'wme-govmap-qld-note';
    const QLD_STYLE_ID = 'wme-govmap-qld-hide';
    const QLD_SHOW_ALL_KEY = 'wme-govmap-qld-show-all';

    function findQLDToc() {
        const toc = window.app && window.app.userMapsController && window.app.userMapsController.TOC;
        if (!toc || typeof toc.findByTocId !== 'function' || !toc.tocModel) return null;
        try {
            return QLD_LAYER_TOC_IDS.some((id) => toc.findByTocId(id)) ? toc : null;
        } catch (err) {
            return null;
        }
    }

    /**
     * The ids of every layer and folder Waze can't use: layers matching the
     * rules above, plus folders holding nothing but those.
     */
    function qldExcludedIds(toc) {
        const excluded = new Set();
        const childrenOf = (node) => {
            const model = node.model || node;
            for (const key of ['children', 'nodes', 'items']) {
                if (Array.isArray(node[key]) && node[key].length) return node[key];
                if (model && Array.isArray(model[key]) && model[key].length) return model[key];
            }
            return [];
        };
        const visit = (node) => {
            const model = node.model || node;
            const id = model && model.tocId;
            const children = childrenOf(node);
            if (!children.length) {
                const hit = Boolean(id) && (
                    (model.serviceId && QLD_EXCLUDED_SERVICES.test(model.serviceId))
                    || QLD_EXCLUDED_IDS.includes(id)
                    || QLD_EXCLUDED_ID_PREFIXES.some((prefix) => id.startsWith(prefix)));
                if (hit) excluded.add(id);
                return hit;
            }
            const results = children.map(visit);
            const all = results.every(Boolean);
            if (all && id && id !== 'toc-root') excluded.add(id);
            return all;
        };
        visit(toc.tocModel);
        return excluded;
    }

    /**
     * Switches on the recommended layers and the Imagery basemap, and
     * switches off any layer Waze can't use (by default, just the Esri
     * "World basemap grey"). Fires the same
     * page event QLD Globe's own layer list fires when you tick a layer, and
     * only for layers that need changing.
     */
    async function setQLDLayers() {
        const toc = await waitUntil(findQLDToc, { timeout: 20000, label: 'the layer list' });
        const findNode = (id) => {
            try {
                return toc.findByTocId(id);
            } catch (err) {
                return null;
            }
        };
        const isSelected = (id) => {
            const node = findNode(id);
            return Boolean(node && node.model && node.model.selected);
        };

        const missing = QLD_LAYER_TOC_IDS.filter((id) => !findNode(id));
        if (missing.length) log(`QLD Globe: these layers no longer exist: ${missing.join(', ')}`);

        const turnOn = [...QLD_LAYER_TOC_IDS, QLD_IMAGERY_ID].filter((id) => findNode(id) && !isSelected(id));
        if (turnOn.length) {
            window.qldglobe.observer.publish('toc-item-select-update-array', { tocIds: turnOn, selected: true });
        }

        const turnOff = [...qldExcludedIds(toc)].filter(isSelected);
        if (turnOff.length) {
            window.qldglobe.observer.publish('toc-item-select-update-array', { tocIds: turnOff, selected: false });
        }
    }

    /**
     * Hides the layers Waze can't use from QLD Globe's layer lists (the
     * catalogue, the selected layers and search results), with a note and a
     * "Show all layers" toggle. QLD Globe draws every layer entry as
     * li[data-id="toc-..."], so a stylesheet does the hiding and keeps working
     * however often the lists are redrawn.
     */
    async function setupQLDLayerView() {
        // Long timeout: when QLD Globe is opened directly, the map (and its
        // layer list) only starts once the user gets past the terms screen.
        const toc = await waitUntil(findQLDToc, { timeout: 300000, label: 'the layer list' });
        if (document.getElementById(QLD_STYLE_ID)) return;

        const excluded = [...qldExcludedIds(toc)];
        const style = document.createElement('style');
        style.id = QLD_STYLE_ID;
        style.textContent = excluded.map((id) => `li[data-id="${id}"]`).join(',\n') + ' { display: none !important; }';
        document.head.appendChild(style);

        // Hiding a layer's row doesn't stop it being switched on: ticking a
        // folder in "All layers" (e.g. Boundaries) switches on everything in
        // it, hidden layers included. QLD Globe publishes "render-toc" once a
        // change has been applied, so after each one, switch back off any
        // layer Waze can't use - unless the user has chosen to see them all.
        // Switching them off publishes one more render-toc, which then finds
        // nothing to do.
        let showAll = readShowAll(QLD_SHOW_ALL_KEY);
        const isSelected = (id) => {
            try {
                const node = toc.findByTocId(id);
                return Boolean(node && node.model && node.model.selected);
            } catch (err) {
                return false;
            }
        };
        const switchOffExcluded = () => {
            if (showAll) return;
            const on = excluded.filter(isSelected);
            if (!on.length) return;
            log(`QLD Globe: switching off layers Waze can't use: ${on.join(', ')}`);
            window.qldglobe.observer.publish('toc-item-select-update-array', { tocIds: on, selected: false });
        };
        window.qldglobe.observer.subscribe('render-toc', () => {
            setTimeout(switchOffExcluded, 0);
            setTimeout(switchOffExcluded, 1500); // in case its layers were still loading
        });

        const applyView = (checked) => {
            showAll = checked;
            style.disabled = showAll;
            switchOffExcluded();
        };
        applyView(showAll);

        // One note in each of the Layers sidebar's lists (your layers, and
        // the full catalogue), inside the scrolling list so the panel's
        // header can't cover it. The two toggles stay in step.
        const notes = [];
        const makeNote = (suffix) => createAllowedLayersNote({
            id: `${QLD_NOTE_ID}-${suffix}`,
            storageKey: QLD_SHOW_ALL_KEY,
            message: `Layers Waze editors can't use are hidden: satellite imagery, tourism data, postcode and federal electoral `
                + `boundaries (per QLD Globe's <a href="https://qldglobe.information.qld.gov.au/help-info/Specific-data-conditions.html" `
                + `target="_blank" rel="noopener" style="color:inherit">data licence conditions</a>), and data from other `
                + `organisations' services (NSW, Native Title Tribunal, NHVR, Energy Queensland, Esri). `
                + 'The Imagery basemap is licensed satellite imagery &ndash; use it to get your bearings only, never copy from it. '
                + `See the ${GUIDE_LINK}.`,
            onToggle: (checked) => {
                applyView(checked);
                for (const other of notes) other.querySelector('input').checked = checked;
            },
        });

        // The lists are drawn when the Layers panel is first opened and can
        // be redrawn, so keep the notes at the top of them.
        const placeNotes = () => {
            for (const [pane, suffix] of [['layers-my', 'my'], ['layers-all', 'all']]) {
                const list = document.querySelector(
                    `#sidebar-layers-inner .layers-tab-content.${pane} .sidebar-scroll-pane .mCSB_container`);
                if (!list) continue;
                let note = document.getElementById(`${QLD_NOTE_ID}-${suffix}`);
                if (!note) {
                    note = makeNote(suffix);
                    notes.push(note);
                }
                if (list.firstElementChild !== note) list.insertBefore(note, list.firstElementChild);
            }
        };
        placeNotes();
        onDomChange(document.getElementById('sidebar-layers') || document.body, placeNotes);
    }

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

            // The map (and its layer list) only starts once the splash is
            // dismissed. Switching the layers on runs alongside the search
            // rather than holding it up.
            setQLDLayers().catch((err) => log(`QLD Globe: could not set the layers: ${err.message}`));

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

    // Layers switched on when NR Maps opens: the ones the AU third-party data
    // guide (https://www.waze.com/discuss/t/375455) has ticked, plus Parcel
    // Numbers (NR Maps' default, and allowed) and the Coastline basemap. Keyed
    // on NR Maps' own layer names, which are stable.
    const NT_LAYERS_ON = [
        'ntlis:CADASTRE',
        'ntlis:GENERAL_TEXT',
        'ntlis:PARCEL_NUMBERS',
        'ntlis:MAJOR_TOWNS_NT_DISPLAY',
        'ntlis:PLACENAMES',
        'ntlis:RAILWAYS',
        'ntlis:ROAD_CENTRELINES',
        'ntlis:ROAD_LABELS',
        'ntlis:LOCALITIES',
        'ntlis:COASTLINE', // basemap
    ];

    // The top-level NR Maps folders the guide covers: Land Administration is
    // its "layers you can freely use" screenshot, Basemaps its "use with
    // caution" one (fine for getting your bearings, never copy data). Every
    // other folder is hidden unless the user asks to see all layers.
    const NT_ALLOWED_FOLDERS = ['Land Administration', 'Basemaps'];
    const NT_NOTE_ID = 'wme-govmap-nt-note';
    const NT_SHOW_ALL_KEY = 'wme-govmap-nt-show-all';

    const ntFolderName = (node) => (node.text || '').replace(/<[^>]+>/g, '').trim();

    function ntTopFolder(node) {
        let top = node;
        while (top.parentNode && !top.parentNode.isRoot) top = top.parentNode;
        return top;
    }

    /** True if every allowed folder is in the tree under its expected name. */
    function ntAllowedFoldersPresent(tree, { quiet = false } = {}) {
        const names = tree.getRootNode().childNodes.map(ntFolderName);
        const missing = NT_ALLOWED_FOLDERS.filter((name) => !names.includes(name));
        if (missing.length && !quiet) log(`NR Maps: couldn't find the ${missing.join(' and ')} folder(s).`);
        return missing.length === 0;
    }

    function findNTLayerTree() {
        const ext = window.Ext;
        if (!ext || !ext.ComponentMgr) return null;
        let tree = null;
        ext.ComponentMgr.all.each((component) => {
            if (!tree && component.getRootNode && component.root && /tocView/.test(component.id)) tree = component;
        });
        return tree;
    }

    /**
     * The names of the layers NR Maps is actually drawing, read from its map
     * request (whose layer ids index into the map engine's layer list). This
     * is more trustworthy than the layer list: the tree's own `checked` flag
     * isn't kept up to date, and a ticked layer inside an unticked folder
     * isn't drawn. Returns null if the request can't be read.
     */
    function ntDrawnLayers() {
        try {
            let map = null;
            window.Ext.ComponentMgr.all.each((component) => {
                if (!map && component.map && component.map.layers && component.map.getScale) map = component.map;
            });
            const engine = map.layers.find((layer) => layer.name === 'mapengine.geoserver');
            const ids = JSON.parse(engine.params['request.data']).map.layerids;
            return new Set(ids.map((i) => engine.layers[i] && engine.layers[i].id).filter(Boolean));
        } catch (err) {
            return null;
        }
    }

    /**
     * Clicks a layer's tick icon the way a user would. Folders opened to reach
     * it are closed again afterwards.
     */
    async function clickNTLayer(node) {
        const opened = [];
        for (let parent = node.parentNode; parent && !parent.isRoot; parent = parent.parentNode) {
            if (!parent.isExpanded()) opened.push(parent);
        }
        node.ensureVisible();

        const ui = node.getUI();
        const icon = await waitUntil(() => ui.iconNode, { timeout: 3000, label: `the ${node.attributes.layer} tick box` });
        for (const type of ['mousedown', 'mouseup', 'click']) {
            icon.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }

        // No animation: closing several nested folders at once with it on
        // cancels some of the animations and leaves those folders open.
        opened.forEach((folder) => folder.collapse(false, false));
    }

    /**
     * The layer-list node for each layer, split into those in the allowed
     * folders and the rest. The same layer can appear in more than one folder,
     * so the copy in an allowed folder is preferred.
     */
    function ntLayerNodes(tree) {
        const allowedNodes = new Map();
        const otherNodes = new Map();
        tree.getRootNode().cascade((node) => {
            const layer = node.attributes.layer;
            if (!layer || node.isRoot) return;
            const nodes = NT_ALLOWED_FOLDERS.includes(ntFolderName(ntTopFolder(node))) ? allowedNodes : otherNodes;
            if (!nodes.has(layer)) nodes.set(layer, node);
        });
        return { allowedNodes, otherNodes };
    }

    // Holds NR Maps' "Active Layer" selection tool, which is on by default.
    const NT_TOOL_FOLDERS = ['Selection'];

    /**
     * Switches off anything being drawn from outside the allowed folders.
     * The drawn list only covers NR Maps' main map service, so hidden folders
     * that are ticked are also unticked, which stops everything in them
     * whichever service it comes from.
     */
    async function switchOffNTOutsideAllowed() {
        const tree = findNTLayerTree();
        const drawn = ntDrawnLayers();
        if (!tree || !drawn || !ntAllowedFoldersPresent(tree)) return;
        const { allowedNodes, otherNodes } = ntLayerNodes(tree);
        for (const layer of drawn) {
            if (!allowedNodes.has(layer) && otherNodes.has(layer)) await clickNTLayer(otherNodes.get(layer));
        }
        for (const folder of tree.getRootNode().childNodes) {
            const name = ntFolderName(folder);
            if (NT_ALLOWED_FOLDERS.includes(name) || NT_TOOL_FOLDERS.includes(name)) continue;
            const icon = folder.getUI().iconNode;
            if (icon && /checkon/.test(icon.src)) await clickNTLayer(folder);
        }
    }

    /**
     * Switches on NT_LAYERS_ON, and switches off anything being drawn from
     * outside the allowed folders so nothing hidden by the allowed-layers view
     * is quietly on. Other allowed layers are left as they are.
     */
    async function setNTLayers() {
        const tree = await waitUntil(findNTLayerTree, { label: 'the layer list' });
        const drawn = await waitUntil(ntDrawnLayers, { timeout: 10000, label: 'the map layers' });
        const { allowedNodes, otherNodes } = ntLayerNodes(tree);

        for (const layer of NT_LAYERS_ON) {
            const node = allowedNodes.get(layer) || otherNodes.get(layer);
            if (!node) log(`NR Maps: layer ${layer} no longer exists.`);
            else if (!drawn.has(layer)) await clickNTLayer(node);
        }
        await switchOffNTOutsideAllowed();
    }

    /**
     * Trims NR Maps' layer list down to the allowed folders, with a note
     * explaining why and a "Show all layers" toggle (remembered between
     * visits). Leaves the list alone if the allowed folders can't be found.
     */
    async function setupNTLayerView() {
        // NR Maps builds its layer tree some time after the page loads (it can
        // take a while), so wait for the folders themselves, not just the tree.
        const readyTree = () => {
            const tree = findNTLayerTree();
            return tree && tree.body && ntAllowedFoldersPresent(tree, { quiet: true }) ? tree : null;
        };
        try {
            await waitUntil(readyTree, { timeout: 120000, label: 'the layer list' });
        } catch (err) {
            const tree = findNTLayerTree();
            if (tree) ntAllowedFoldersPresent(tree);
            throw err;
        }
        if (document.getElementById(NT_NOTE_ID)) return;

        let showAll = readShowAll(NT_SHOW_ALL_KEY);
        let note = null;
        const wrappedFilters = new WeakSet();

        // NR Maps can redraw or rebuild the tree after this runs, which drops
        // the note and un-hides the folders, so everything here is re-applied
        // against whatever tree is current whenever the page changes.
        const applyView = () => {
            const tree = readyTree();
            if (!tree) return;

            const body = tree.body.dom;
            if (body.firstChild !== note) body.insertBefore(note, body.firstChild);

            for (const folder of tree.getRootNode().childNodes) {
                const ui = folder.getUI();
                const show = showAll || NT_ALLOWED_FOLDERS.includes(ntFolderName(folder));
                const hidden = Boolean(ui.wrap && ui.wrap.style.display === 'none');
                if (show && hidden) ui.show();
                else if (!show && !hidden) ui.hide();
            }

            // NR Maps' "Search data" box filters the tree and re-shows the
            // folders of anything it matches, so re-apply the view after it.
            const filter = tree.filter;
            if (filter && !wrappedFilters.has(filter)
                && typeof filter.filterBy === 'function' && typeof filter.clear === 'function') {
                wrappedFilters.add(filter);
                const filterBy = filter.filterBy;
                const clear = filter.clear;
                filter.filterBy = function (...args) {
                    const result = filterBy.apply(this, args);
                    applyView();
                    return result;
                };
                filter.clear = function (...args) {
                    const result = clear.apply(this, args);
                    applyView();
                    return result;
                };
            }
        };

        note = createAllowedLayersNote({
            id: NT_NOTE_ID,
            storageKey: NT_SHOW_ALL_KEY,
            message: `Only the layers Waze editors are allowed to use are shown, per the ${GUIDE_LINK}. `
                + 'Basemaps are for getting your bearings only &ndash; never copy data from them.',
            style: 'margin:4px;padding:5px 7px;border:1px solid #99bbe8;background:#dfe8f6;'
                + 'color:#15428b;font:11px tahoma,arial,helvetica,sans-serif;line-height:1.35;',
            onToggle: (checked) => {
                showAll = checked;
                applyView();
                // Hidden layers are also switched off, like QLD. Only done
                // here, not on every page change: NR Maps' tick boxes toggle,
                // so a second click before it updates would switch one back on.
                if (!checked) {
                    switchOffNTOutsideAllowed()
                        .catch((err) => log(`NR Maps: could not switch off hidden layers: ${err.message}`));
                }
            },
        });

        // The note goes at the top of the tree, which changes no panel sizes
        // (anything put in the panel's toolbar area upsets the sidebar layout).
        applyView();
        onDomChange(document.body, applyView);
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

            // 7. Set the layers and basemap to match the guide. Done last so a
            //    problem here can never stop the map getting to the location.
            await setNTLayers()
                .catch((err) => log(`NR Maps: could not set the layers: ${err.message}`));

            log('NR Maps: done.');
        } catch (err) {
            log(`NR Maps automation stopped: ${err.message}`);
        }
    }

    // ------------------------------------------------------------------
    //  MapShare Vic
    // ------------------------------------------------------------------

    // MapShare layers Waze can't use. DEECA material is Creative Commons
    // (https://www.deeca.vic.gov.au/copyright) except third-party content, and
    // these layers' Metashare metadata records put them under the DELWP data
    // licence instead of CC-BY. Keyed on MapShare's service and layer ids.
    // (The Vicmap Basemaps - Cartographic, Aerial, Overlay - are also a
    // licensed service, but are left visible for getting your bearings.)
    const VIC_NOT_ALLOWED = [
        { service: '95', layers: ['0', '1', '2', '3', '4'] }, // Contour 100K-, 70-100K, 1-70K, 20m, 10m
        { service: '300', layers: ['5'] }, // Crown Parcel
    ];
    const VIC_NOTE_ID = 'wme-govmap-vic-note';
    const VIC_SHOW_ALL_KEY = 'wme-govmap-vic-show-all';

    function findVICMap() {
        const client = window.__geocortexNativeMessageClient;
        const map = client && client.app && client.app.site && client.app.site.essentialsMap;
        return map && Array.isArray(map.mapServices) && map.mapServices.length ? map : null;
    }

    function findVICLayer(map, serviceId, layerId) {
        const service = map.mapServices.find((s) => String(s.id) === serviceId);
        let found = null;
        const walk = (layers) => (layers || []).forEach((layer) => {
            if (found) return;
            if (String(layer.id) === layerId) found = layer;
            else walk(layer.subLayers);
        });
        if (service) walk(service.layers);
        return found;
    }

    /**
     * Switches off and hides the MapShare layers Waze can't use, with a note
     * and a "Show all layers" toggle. MapShare's layer list doesn't expose its
     * layers to the page, so entries are matched on the display names read
     * from the layer objects above.
     */
    async function setupVICLayerView() {
        const map = await waitUntil(findVICMap, { timeout: 30000, label: 'the MapShare map' });
        if (document.getElementById(VIC_NOTE_ID)) return;

        const names = new Set();
        const notAllowed = [];
        for (const { service, layers } of VIC_NOT_ALLOWED) {
            for (const id of layers) {
                const layer = findVICLayer(map, service, id);
                if (!layer) {
                    log(`MapShare: layer ${service}/${id} no longer exists.`);
                    continue;
                }
                names.add(String(layer.displayName).trim());
                notAllowed.push(layer);
            }
        }

        let showAll = readShowAll(VIC_SHOW_ALL_KEY);

        // Hidden layers are also switched off, like QLD - unless the user has
        // chosen to see everything. Switching off a layer that's already off
        // does nothing, so this is safe to run on every page change.
        const switchOffHidden = () => {
            if (showAll) return;
            for (const layer of notAllowed) {
                try {
                    if (layer.isVisible()) layer.setVisibility(false);
                } catch (err) {
                    log(`MapShare: could not switch off ${layer.displayName}: ${err.message}`);
                }
            }
        };

        const applyView = () => {
            switchOffHidden();
            for (const item of document.querySelectorAll('.layer-list li.layer')) {
                // Only this entry's own label counts. MapShare wraps groups of
                // sub-layers in unlabelled entries, and taking the first label
                // inside one of those would hide the whole group.
                const label = [...item.querySelectorAll('.display-name')]
                    .find((span) => span.closest('li.layer') === item);
                const hide = !showAll && label && names.has(label.textContent.trim());
                item.style.display = hide ? 'none' : '';
            }
        };

        const note = createAllowedLayersNote({
            id: VIC_NOTE_ID,
            storageKey: VIC_SHOW_ALL_KEY,
            message: `Layers Waze editors can't use are hidden (contours and Crown Parcel are under the DELWP data licence, `
                + `not Creative Commons). The Vicmap basemaps are a licensed service &ndash; use them to get your bearings only. `
                + `See the ${GUIDE_LINK}.`,
            onToggle: (checked) => {
                showAll = checked;
                applyView();
            },
        });

        // The layer list is drawn when it is first opened and redrawn as
        // folders are expanded, so keep the note in place and re-apply. The
        // note goes inside the scrolling list itself: MapShare positions the
        // list at a fixed offset, so anything added above it is drawn over.
        const refresh = () => {
            const list = document.querySelector('.LayerListView .layer-list');
            if (list && list.firstElementChild !== note) list.insertBefore(note, list.firstElementChild);
            applyView();
        };
        refresh();
        onDomChange(document.body, refresh);
    }

    // ------------------------------------------------------------------
    //  Location SA Viewer
    // ------------------------------------------------------------------

    // The guide only allows the Roads dataset (and Road Route Numbers, ticked
    // in its screenshot) and the Satellite map; the Roads and Topographic maps
    // carry house numbers Waze isn't licensed for. Dataset tick boxes are
    // l<uid>, matching the viewer's uids= link parameter.
    const SA_ALLOWED_DATASETS = ['l135', 'l136']; // Road Route Numbers, Roads
    const SA_HIDDEN_BASEMAPS = ['roads', 'topographic'];
    const SA_NOTE_ID = 'wme-govmap-sa-note';
    const SA_SHOW_ALL_KEY = 'wme-govmap-sa-show-all';

    async function setupSALayerView() {
        const tree = await waitUntil(
            () => {
                const el = document.getElementById('legendTree');
                return el && el.querySelector('input[id^="l"]') ? el : null;
            },
            { timeout: 30000, label: 'the dataset list' },
        );
        if (document.getElementById(SA_NOTE_ID)) return;

        const allowedSelector = SA_ALLOWED_DATASETS.map((id) => `#${id}`).join(',');

        // The map currently shown, read from the viewer's own map list.
        const currentBasemap = () => {
            try {
                const tile = document.querySelector("[ng-click^='setBasemap(']");
                const scope = window.angular && tile && window.angular.element(tile).scope();
                const shown = scope && Array.isArray(scope.basemaps) && scope.basemaps.find((b) => b.visible);
                return shown ? shown.id : null;
            } catch (err) {
                return null;
            }
        };

        // Hidden datasets and maps are also switched off, like QLD: untick any
        // dataset that isn't allowed, and switch back to Satellite if a hidden
        // map is showing - unless the user has chosen to see everything. Runs
        // whenever the page changes, so it also catches datasets added through
        // Data Search.
        const switchOffHidden = () => {
            if (showAll) return;
            for (const box of tree.querySelectorAll('input[type="checkbox"][id^="l"]')) {
                if (box.checked && !SA_ALLOWED_DATASETS.includes(box.id)) box.click();
            }
            if (SA_HIDDEN_BASEMAPS.includes(currentBasemap())) {
                const satellite = document.querySelector("[ng-click=\"setBasemap('hybrid')\"]");
                if (satellite) satellite.click();
            }
        };

        let showAll = readShowAll(SA_SHOW_ALL_KEY);
        const applyView = () => {
            for (const item of tree.querySelectorAll('li[role="treeitem"]')) {
                item.style.display = showAll || item.querySelector(allowedSelector) ? '' : 'none';
            }
            for (const name of SA_HIDDEN_BASEMAPS) {
                for (const tile of document.querySelectorAll(`[ng-click="setBasemap('${name}')"]`)) {
                    tile.style.display = showAll ? '' : 'none';
                }
            }
            switchOffHidden();
        };

        const note = createAllowedLayersNote({
            id: SA_NOTE_ID,
            storageKey: SA_SHOW_ALL_KEY,
            message: `Only the road data Waze editors are allowed to use is shown, per the ${GUIDE_LINK}. `
                + 'The Roads and Topographic maps are hidden because they carry house numbers &ndash; use Satellite.',
            onToggle: (checked) => {
                showAll = checked;
                applyView();
            },
        });
        tree.parentNode.insertBefore(note, tree);

        applyView();
        onDomChange(document.body, applyView);
    }

    // ------------------------------------------------------------------
    //  Entry point
    // ------------------------------------------------------------------

    const host = window.location.hostname;

    if (host === 'www.waze.com' || host === 'beta.waze.com') {
        startWME();
    } else if (host.endsWith('qldglobe.information.qld.gov.au')) {
        log('Detected Queensland Globe page.');
        onDocumentReady(() => {
            setupQLDLayerView().catch((err) => log(`QLD Globe: could not set up the layer list: ${err.message}`));
            runAutomationQLD();
        });
    } else if (host.endsWith('nrmaps.nt.gov.au')) {
        log('Detected NR Maps page.');
        onDocumentReady(() => {
            setupNTLayerView().catch((err) => log(`NR Maps: could not set up the layer list: ${err.message}`));
            runAutomationNT();
        });
    } else if (host.endsWith('mapshare.vic.gov.au')) {
        onDocumentReady(() => {
            setupVICLayerView().catch((err) => log(`MapShare: could not set up the layer list: ${err.message}`));
        });
    } else if (host.endsWith('location.sa.gov.au')) {
        onDocumentReady(() => {
            setupSALayerView().catch((err) => log(`Location SA: could not set up the layer list: ${err.message}`));
        });
    }
})();
