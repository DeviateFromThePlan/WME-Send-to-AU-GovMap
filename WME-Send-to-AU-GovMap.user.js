// ==UserScript==
// @name         WME Send to AU GovMap
// @namespace    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap
// @version      2025.03.01.01
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

/* global WazeWrap */
/* global proj4 */

if (window.location.hostname === 'www.waze.com' || window.location.hostname === 'beta.waze.com') {
const ScriptName = GM_info.script.name;
const ScriptVersion = GM_info.script.version;
const ReleaseNotes = '<br><a href="https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases" target="_blank"><img src="https://simpleicons.org/icons/github.svg" width=10> View Release Notes</a>';
const UpdateNotes = '<h4><u>Bug fixes:</u></h4><ul><li>Script was trying to initialise the WME SDK on QLD Globe & NT Maps so the loading code broke. DeviateFromThePlan apologies for the terrible fix he did. 👉👈</li></ul><h4><u>Known bugs:</u></h4><ul><li>Script tries to load QLD Globe code too early, so it requires a refresh before it actually works. Fix coming soon!</li></ul>';
let wmeSDK;

function log(message) {
    if (typeof message === 'string') {
        console.log(ScriptName+': ' + message);
    } else {
        console.log(ScriptName+': ', message);
    }
}

// the sdk init function will be available after the WME is initialized
function WMESendtoAUGovMap_bootstrap() {
    if (!wmeSDK.DataModel.Countries.getTopCountry() || !WazeWrap.Ready) {
        setTimeout(WMESendtoAUGovMap_bootstrap, 250);
        return;
    }

    if (wmeSDK.State.isReady) {
        WMESendtoAUGovMap_init();
    } else {
        wmeSDK.Events.once({ eventName: "wme-ready" }).then(WMESendtoAUGovMap_init);
    }
}

const WGS_84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs';
const VIC_GRID_94 = '+proj=tmerc +lat_0=-37 +lon_0=145 +k=1 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs';

function WMESendtoAUGovMap_init() {
    log("Start");

    WazeWrap.Interface.ShowScriptUpdate(ScriptName, ScriptVersion, UpdateNotes+ReleaseNotes, '');

    // Footer button
    let mapLinkElement = document.createElement('a');
    mapLinkElement.id = 'WME-showState';
    mapLinkElement.classList.add('wz-map-black-link');
    mapLinkElement.innerText = '🇦🇺 GovMap';
    mapLinkElement.style = 'cursor: pointer';
    mapLinkElement.onclick = getMapLink;

    let mousePositionElement = document.getElementsByClassName('wz-map-ol-control-mouse-position')[0];
    mousePositionElement.parentNode.insertBefore(mapLinkElement, mousePositionElement.nextSibling);

    function getMapLink() {
        let country = wmeSDK.DataModel.Countries.getTopCountry();
        let state = wmeSDK.DataModel.States.getTopState();

        // Check compatability
        if (country.name !== 'Australia') {
            return WazeWrap.Alerts.warning(ScriptName, "Sorry but we currently don't support loading maps from other countries but Australia.");
        }

        if (!state.name || state.name == null) {
            return WazeWrap.Alerts.warning(ScriptName, "Please move closer to land.");
        }

        switch (state.name) {
            case 'Victoria':
                return openMapshareVic();
            case 'South Australia':
                return openLocationSAViewer();
            case 'New South Wales':
                return openGisNSW();
            case 'Tasmania':
                return openGisTAS();
            case 'Western Australia':
                return openGisWA();
            case 'Australian Capital Territory':
                return openGisACT();
            case 'Queensland':
                return openQueenslandGlobe();
            case 'Northern Territory':
                return openNRMaps();
            default:
                return WazeWrap.Alerts.warning(ScriptName, "Sorry but we currently don't support loading maps from " + state.name + '.');
        }
    }

    ////////////////
    //  VICTORIA  //
    ////////////////
    function openMapshareVic() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();

        if (isNaN(lat) || isNaN(lon)) {
            log('Invalid coordinates');
            return false;
        }

        let [x, y] = proj4(WGS_84, VIC_GRID_94, [lon, lat]);
        let scaleMin = 976.5644531289063;
        let scaleMax = 8000016.000032;
        let scale = scaleMax;
        let wazeZoom = wmeSDK.Map.getZoomLevel();

        if (wazeZoom <= 5) {
            scale = scaleMax;
        } else if (wazeZoom >= 20) {
            scale = scaleMin;
        }
        else
        {
            for (let i = 6; i < wazeZoom; i++) {
                scale /= 2;
            }
        }

        const mapURL = `https://mapshare.vic.gov.au/mapsharevic/?scale=${scale}&center=${x}%2C${y}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

    ///////////////////////
    //  SOUTH AUSTRALIA  //
    ///////////////////////
    function openLocationSAViewer() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();

        if (isNaN(lat) || isNaN(lon)) {
            log('Invalid coordinates');
            return false;
        }

        let wazeZoom = wmeSDK.Map.getZoomLevel();
        let scale = null;

        if (wazeZoom >= 6) {
            scale = wazeZoom;
        }

        const mapURL = `https://location.sa.gov.au/viewer/?map=hybrid&x=${lon}&y=${lat}&z=${scale}&uids=135,136`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

    /////////////////////
    // NEW SOUTH WALES //
    /////////////////////
    function openGisNSW() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();
        let scale = wmeSDK.Map.getZoomLevel();

        const mapURL = `https://www.arcgis.com/home/webmap/viewer.html?basemapUrl=http%3A%2F%2Fmaps.six.nsw.gov.au%2Farcgis%2Frest%2Fservices%2Fpublic%2FNSW_Base_Map%2FMapServer&center=${lon},${lat}&level=${scale}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

    //////////////
    // TASMANIA //
    //////////////
    function openGisTAS() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();

        let scale;
        let wazeZoom = wmeSDK.Map.getZoomLevel();

        if (wazeZoom >= 19) {
            scale = 18;
        }
        else
        {
            scale = wazeZoom;
        }

        const mapURL = `https://www.arcgis.com/home/webmap/viewer.html?basemapUrl=https%3A%2F%2Fservices.thelist.tas.gov.au%2Farcgis%2Frest%2Fservices%2FBasemaps%2FSimpleBasemap%2FMapServer&basemapReferenceUrl=https%3A%2F%2Fservices.thelist.tas.gov.au%2Farcgis%2Frest%2Fservices%2FPublic%2FTopographyAndRelief%2FMapServer%2F7&url=https%3A%2F%2Fservices.thelist.tas.gov.au%2Farcgis%2Frest%2Fservices%2FPublic%2FTopographyAndRelief%2FMapServer%2F7&center=${lon},${lat}&level=${scale}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

    ///////////////////////
    // WESTERN AUSTRALIA //
    ///////////////////////
    function openGisWA() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();

        const mapURL = `https://www.arcgis.com/home/webmap/viewer.html?basemapUrl=https://gisservices.mainroads.wa.gov.au/arcgis/rest/services/OpenData/RoadAssets_DataPortal/MapServer/?layers=show:11&url=https://gisservices.mainroads.wa.gov.au/arcgis/rest/services/OpenData/RoadAssets_DataPortal/MapServer/?layers=show:17&find=${lon},${lat}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

    //////////////////////////////////
    // AUSTRALIAN CAPITAL TERRITORY //
    //////////////////////////////////
    function openGisACT() {
        let { lon, lat } = wmeSDK.Map.getMapCenter();
        let scale = wmeSDK.Map.getZoomLevel();

        const mapURL = `https://actmapi-actgov.opendata.arcgis.com/datasets/actgov-road-centrelines/explore?location=${lat}%2C${lon}%2C${scale}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }

	//////////////////
    //  QUEENSLAND  //
    //////////////////

        function openQueenslandGlobe() {
            let { lon, lat } = wmeSDK.Map.getMapCenter();

         let wazeZoom = wmeSDK.Map.getZoomLevel();
            const BASE_SCALE = 564;

        // Calculate scale factor
        const scale = BASE_SCALE * Math.pow(2, 20 - wazeZoom);

        const mapURL = `https://qldglobe.information.qld.gov.au/?center=${lat},${lon}&scale=${scale}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }


	///////////////////////////
    //  NORTHERN TERRITORY  //
    //////////////////////////

            function openNRMaps() {
            let { lon, lat } = wmeSDK.Map.getMapCenter();

                         let wazeZoom = wmeSDK.Map.getZoomLevel();
            const BASE_SCALE = 564;

        // Calculate scale factor
        const scale = BASE_SCALE * Math.pow(2, 20 - wazeZoom);
        const mapURL = `https://nrmaps.nt.gov.au/nrmaps.htm#center=${lat},${lon}&scale=${scale}`;
        window.open(mapURL, '_blank');

        //Prevent default 'a' tag functionality
        return false;
    }


    displayChangelog();

    log("Done");

}
    	window.SDK_INITIALIZED.then(() => {
    // initialize the sdk with your script id and script name
    wmeSDK = getWmeSdk({scriptId: "wme-send-to-AU-GovMap", scriptName: "Send to AU GovMap"});
    WMESendtoAUGovMap_bootstrap();
});

function displayChangelog() {
    if (!WazeWrap.Interface) {
        setTimeout(displayChangelog, 1000);
        return;
    }
}
}

// Helper function to introduce delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to wait until the element is available in the DOM
function waitForElement(selector, callback) {
	const interval = setInterval(() => {
		const element = document.querySelector(selector);
		if (element) {
			clearInterval(interval);
			callback(element);
		}
	}, 100);
}

// Get hash parameters from url
function getHashParams() {
	const hash = window.location.hash.substring(1); // Remove the leading '#'
	const params = new URLSearchParams(hash);
	const center = params.get('center');
	const scale = params.get('scale');
	return { center, scale };
}

// Get cordinates from parameters
function getCords(cords) {
	const coordinates = cords.split(',');
	if (coordinates.length === 2) {
		const lat = parseFloat(coordinates[0]);
		const lon = parseFloat(coordinates[1]);
		if (!isNaN(lat) && !isNaN(lon)) {
			return { lat, lon };
		}
	}
}

// Simulate changing the value of an input
function changeValue(selector, value) {
    const inputElement = document.querySelector(selector);
    if (inputElement) {
       inputElement.value = value;
       inputElement.dispatchEvent(new Event('input', { bubbles: true })); // Ensure the change is registered
    }
	else {
       console.error(`Element not found for selector: ${selector}`);
    }
}

// Simulate a click on an element
function clickElement(selector) {
	const element = document.querySelector(selector);
	if (element) {
		element.click();
		}
		else {
		console.error(`Element not found for selector: ${selector}`);
        }
    }

// Evaluate the XPath and find element
function clickElementByXPath(xpath) {
    const element = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
    ).singleNodeValue;

    if (element) {
        console.log(`Element found for XPath '${xpath}'. Clicking it now.`);
        element.click(); // Trigger the click event
    } else {
        console.warn(`No element found for XPath '${xpath}'.`);
    }
}

// NR Maps Automation
async function runAutomationNT(){const{center:e,scale:t}=getHashParams(),n=getCords(e),{lat:c,lon:o}=n;waitForElement("#ext-gen233",(()=>{clickElement("#ext-gen233")})),waitForElement("#ext-comp-1220",(()=>{changeValue("#ext-comp-1220",c)})),waitForElement("#ext-comp-1221",(()=>{changeValue("#ext-comp-1221",o)})),waitForElement("#ext-gen493",(()=>{clickElement("#ext-gen493")})),waitForElement("#ext-gen492",(()=>{clickElement("#ext-gen492")})),waitForElement("#ext-gen595",(()=>{clickElementByXPath('//*[@id="ext-gen595"]/div[1]')})),waitForElement("#ext-gen436",(function(){const e=document.querySelector("#ext-gen436");e&&(e.click(),waitForElement("#ext-comp-1147",(function(){const e=document.querySelector("#ext-comp-1147");if(e){e.value=t,e.dispatchEvent(new Event("input"));const n=new KeyboardEvent("keydown",{key:"Enter",keyCode:13,bubbles:!0,cancelable:!0});e.dispatchEvent(n)}})))})),waitForElement("#ext-gen438",(()=>{clickElement("#ext-gen438")}))}

// QLD Globe Automation
async function runAutomationQLD(){let t=new URLSearchParams(window.location.search),e=t.get("center"),n=t.get("scale");if(t&&e&&n){let a=getCords(e);console.log(`Using coordinates: Latitude = ${a.lat}, Longitude = ${a.lon}`),await new Promise(t=>waitForElement("div.terms > div",()=>{clickElement("div.terms > div"),t()}));let i=async(t,e=0)=>{let n=document.querySelector(t);n?(n.click(),console.log(`Clicked: ${t}`),e&&await delay(e)):console.warn(`${t} not found. Skipping...`)};await i("#mCSB_7_container > a",2e3),await i("li.contains-icon-search i",1e3),await i("#sidebar-search li:nth-of-type(6)",1e3),changeValue("#sidebar-search input",`${a.lat},${a.lon}`),console.log(`Entered coordinates: ${a.lat},${a.lon}`),await delay(500);let o=document.querySelector("div.form i");o?(o.addEventListener("click",async()=>{console.log("Search button clicked. Waiting for action to complete..."),await delay(2e3);let t=document.querySelector("#scale-control input");t?(t.value=n,t.dispatchEvent(new Event("input",{bubbles:!0})),t.dispatchEvent(new Event("change",{bubbles:!0})),console.log(`Scale set to: ${n}`)):console.warn("Scale input not found. Skipping...")}),o.click(),console.log("Submitted the search.")):console.warn("Search button not found. Skipping..."),console.log("Automation completed.")}else console.log("Nothing to automate.")}


// Check if we are on the Queensland Globe website
"qldglobe.information.qld.gov.au"===window.location.hostname&&(console.log("Detected Queensland Globe page."),window.addEventListener("load",(()=>{console.log("Page loaded. Starting automation..."),runAutomationQLD()})));

// Check if we are on the NR Maps website
"nrmaps.nt.gov.au"===window.location.hostname&&(console.log("Detected NR Maps page."),window.addEventListener("load",(()=>{console.log("Page loaded. Starting automation..."),runAutomationNT()})));
