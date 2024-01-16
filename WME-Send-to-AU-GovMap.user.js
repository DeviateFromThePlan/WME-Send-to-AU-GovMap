// ==UserScript==
// @name         WME Send to AU GovMap
// @namespace    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap
// @version      2024.01.15.01
// @description  Opens your government's map to the coordinates currently in WME.
// @author       DeviateFromThePlan, maporaptor & lacmacca
// @license      MIT
// @match        *://*.waze.com/*editor*
// @exclude      *://*.waze.com/user/editor*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.7.5/proj4.js
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @downloadURL  https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases/latest/download/WME-Send-to-AU-GovMap.user.js
// @updateURL    https://github.com/DeviateFromThePlan/WME-Send-to-AU-GovMap/releases/latest/download/WME-Send-to-AU-GovMap.user.js
// ==/UserScript==

// Updates informations
var UpdateNotes = "";
const _WHATS_NEW_LIST = { // New in this version
    '2024.01.11.01': 'Initial Version',
    '2024.01.15.01': 'Added support for SA & NSW; Added an option to trigger script with the G-key, rather than the button; Renamed to WME Send to AU GovMap',
};
// Var declaration
var ScriptName = GM_info.script.name;
var ScriptVersion = GM_info.script.version;
var segmentcount = 0;
var actionsloaded = 0;
var govmapGKeyEnabled = false;
var neededparams = {
    WMESTDCountry: "",
    WMESTDState: "",
    WMESTDServer: "",
};

(function() {
    'use strict';
    const SCRIPT_NAME = 'WME Send to AU GovMap'
    const wgs84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs';
    const vicGrid94 = '+proj=tmerc +lat_0=-37 +lon_0=145 +k=1 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs';

    function bootstrap() {
      if (typeof W === 'object' && W.userscripts?.state.isReady) {
        init();
      } else {
        document.addEventListener('wme-ready', init, {
            once: true,
        });
      }
    }

// Check the version of the scritpt in the browser to Warn if the script has been updates
function VersionCheck() {
    ///////////////////////////////////////
    //         Check for updates         //
    ///////////////////////////////////////
    if (localStorage.getItem('WMESTDVersion') === ScriptVersion && 'WMESTDVersion' in localStorage) {
        // Do nothing
    } else if ('WMESTDVersion' in localStorage) {
        if(!WazeWrap.Interface) {
            setTimeout(VersionCheck, 1000);
            log("WazeWrap not ready, waiting");
            return;
        }
        UpdateNotes = "";
        for (var key in _WHATS_NEW_LIST) {
            if(ScriptVersion === key) {
                UpdateNotes = "What's New ?<br />";
            }
            if(UpdateNotes != "")
            {
                UpdateNotes = UpdateNotes + "<br />" + key + ": " + _WHATS_NEW_LIST[key];
            }
        }
        UpdateNotes = UpdateNotes + "<br />&nbsp;";
        WazeWrap.Interface.ShowScriptUpdate(ScriptName, ScriptVersion, UpdateNotes, "");
        localStorage.setItem('WMESTDVersion', ScriptVersion);
        $(".WWSUFooter a").text("Gitlab")
    } else {
        localStorage.setItem('WMESTDVersion', ScriptVersion);
    }
}

    function init() {
      debug('Initialising');

      // Settings tab
      let $section = $("<div>");
      $section.html([
        '<h4>WME Send to AU GovMap</h4>',
        '<h6>Controls</h6>',
        '<form id="controls" name="controls">',
        '<input type="checkbox" id="govmapGKey" name="govmapGKey" value="true"/> G Key',
        '</form>'
      ].join(''));
      WazeWrap.Interface.Tab('GovMap', $section.html(), function(){});
     
        
        $('#govmapGKey').change(function() {
            govmapGKeyEnabled = this.checked;
            console.log("WME Send to AU GovMap: G-Key control "+govmapGKeyEnabled);
        });

      // Button
      let mapLinkElement = document.createElement('a');
      mapLinkElement.id = 'WME-showState';
      mapLinkElement.classList.add('wz-map-black-link');
      mapLinkElement.innerText = '🇦🇺 GovMap';
      mapLinkElement.onclick = getMapLink;

      let liveMapElement = document.getElementsByClassName('wz-map-ol-control-mouse-position')[0];
      liveMapElement.parentNode.insertBefore(mapLinkElement, liveMapElement.nextSibling);

	setTimeout(VersionCheck(),2000);
    }

        function getMapLink() {
        var country = W.model.getTopCountry();
        var state = W.model.getTopState();

        if(WazeWrap.Util.mapReady && WazeWrap.Util.modelReady)
        {
            clearInterval(refreshState);
            refreshState = null;

            // Check compatability
            if(country.getName() === "Australia") {
                if(W.map.getZoom() < 12) {
                    return WazeWrap.Alerts.warning(ScriptName, 'Please Zoom in to at least Level 12.');
                }
                else if(state.getName()) {
                    if(state.getName() === "Victoria")
                    {
                        return openMapshareVic(); // Victoria
                    }
                    else if(state.getName() === 'South Australia')
                    {
                        return openLocationSAViewer(); // South Australia
                    }
                    else if(state.getName() === 'New South Wales')
                    {
                        return openGisNSW(); // New South Wales
                    }
                    else
                    {
                        return WazeWrap.Alerts.warning(ScriptName, 'Sorry but we currently don\'t support loading maps from '+state.getName()+'.');
                    }
                }
                else if(state.getName() === '') {
                    return WazeWrap.Alerts.warning(ScriptName, 'Please move closer to land.');
                }
            }
            else {
               return WazeWrap.Alerts.warning(ScriptName, 'Sorry but we currently don\'t support loading maps from other countries but Australia.');
            }
        }
        else {
          var refreshState = setInterval(this, 1000);
          return refreshState;
       }
        }

        $('#govmapGKey').change(() => {
            // If value is always guaranteed to be true/false, you can omit the `=== true`.
            const govmapGKeyEnabled = document.controls.govmapGKey.value === true;
            console.log("WME Send to AU GovMap GKey controls are "+govmapGKeyEnabled);
        });


    ////////////////
    //  VICTORIA  //
    ////////////////
    function openMapshareVic() {
      let {lon: wazeLon, lat: wazeLat} = W.map.getCenter();
      const {lon, lat} = WazeWrap.Geometry.ConvertTo4326(wazeLon, wazeLat);

      if (isNaN(lat) || isNaN(lon)) {
        debug('Invalid coordinates');
        return false;
      }

      	const [x, y] = proj4(wgs84, vicGrid94, [lon, lat]);
		let scaleMin = 976.5644531289063;
        let scaleMax = 8000016.000032;
		let scale = scaleMax;
        let WMEscale = W.map.getZoom();

      if (WMEscale <= 5) {
          scale = scaleMax;
      } else if (WMEscale >= 20) {
          scale = scaleMin;
      }
	  else {
      	for (let i = 6; i < WMEscale; i++) {
        	scale /= 2;
	  	}
      }
      
      const mapURL = `https://mapshare.vic.gov.au/mapsharevic/?scale=${scale}&center=${x}%2C${y}`;
      window.open(mapURL, '_blank');

      //Prevent default a tag functionality
      return false;
    }

    ///////////////////////
    //  SOUTH AUSTRALIA  //
    ///////////////////////
        function openLocationSAViewer() {
       let {lon: wazeLon, lat: wazeLat} = W.map.getCenter();
      const {lon, lat} = WazeWrap.Geometry.ConvertTo4326(wazeLon, wazeLat);
      const [x, y] = [lon, lat];

      if (isNaN(lat) || isNaN(lon)) {
        debug('Invalid coordinates');
        return false;
      }

            function shortenCoordinates(latitude, longitude, decimalPlaces = 4) {
    const shortenedLat = latitude.toFixed(decimalPlaces);
    const shortenedLon = longitude.toFixed(decimalPlaces);
    return [parseFloat(shortenedLat), parseFloat(shortenedLon)];
}

        let WMEscale = W.map.getZoom();
        let zoom = null;

      if (WMEscale >= 6) {
          zoom = WMEscale;
      }

      const mapURL = `https://location.sa.gov.au/viewer/?map=hybrid&x=${x}&y=${y}&z=${zoom}`;
      window.open(mapURL, '_blank');

      //Prevent default a tag functionality
      return false;
    }

    /////////////////////
    // NEW SOUTH WALES //
    /////////////////////
    function openGisNSW() {
        let {lon: wazeLon, lat: wazeLat} = W.map.getCenter();
        const {lon, lat} = WazeWrap.Geometry.ConvertTo4326(wazeLon, wazeLat);
        const [x, y] = [lon, lat];

        const mapURL = `https://www.arcgis.com/home/webmap/viewer.html?basemapUrl=http%3A%2F%2Fmaps.six.nsw.gov.au%2Farcgis%2Frest%2Fservices%2Fpublic%2FNSW_Base_Map%2FMapServer&find=${x},${y}`;
        window.open(mapURL, '_blank');

        //Prevent default a tag functionality
        return false;
    }

    // General Stuff
        // Function to handle the keydown event
        function activateGkey() {
            // Check if the mouse is over the map area
            // You may need to adjust the selector based on the Waze Map Editor structure
            if (document.querySelector('#WazeMap:hover') && (event.key === 'g' || event.key === 'G') && govmapGKeyEnabled === true) {
                getMapLink();
            }
        }
    
        document.addEventListener('keydown', activateGkey);

    function debug(message) {
      console.log(`${SCRIPT_NAME}: ${message}`);
    }

    bootstrap();
})();
