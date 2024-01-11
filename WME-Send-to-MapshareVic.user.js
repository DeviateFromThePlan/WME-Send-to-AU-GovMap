// ==UserScript==
// @name         WME Send to MapshareVic
// @namespace    https://github.com/DeviateFromThePlan/WME-Send-to-MapshareVic
// @version      2024.01.11.01
// @description  Opens MapshareVic to the coordinates currently in WME.
// @author       DeviateFromThePlan, maporaptor & lacmacca
// @license      MIT
// @match        *://*.waze.com/*editor*
// @exclude      *://*.waze.com/user/editor*
// @grant        none
// @require      https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.7.5/proj4.js
// @require      https://greasyfork.org/scripts/24851-wazewrap/code/WazeWrap.js
// @downloadURL  https://github.com/DeviateFromThePlan/WME-Send-to-MapshareVic/releases/latest/download/WME-Send-to-MapshareVic.user.js
// @updateURL    https://github.com/DeviateFromThePlan/WME-Send-to-MapshareVic/releases/latest/download/WME-Send-to-MapshareVic.user.js
// ==/UserScript==

(function() {
    'use strict';
    const SCRIPT_NAME = 'WME Send to MapshareVic'
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

    function init() {
      debug('Initialising');

      let mapShareElement = document.createElement('a');
      mapShareElement.id = 'WME-MapShare';
      mapShareElement.classList.add('wz-map-black-link');
      mapShareElement.innerText = 'MapshareVic';
      mapShareElement.onclick = openMapshareVic;

      let liveMapElement = document.getElementsByClassName('wz-map-ol-control-mouse-position')[0];
      liveMapElement.parentNode.insertBefore(mapShareElement, liveMapElement.nextSibling);
    }

    // Function to open MapshareVic with the coordinates at the center of the screen
    function openMapshareVic() {
      let {lon: wazeLon, lat: wazeLat} = W.map.getCenter();
      const {lon, lat} = WazeWrap.Geometry.ConvertTo4326(wazeLon, wazeLat);

      if (isNaN(lat) || isNaN(lon)) {
        debug('Invalid coordinates');
        return false;
      }

      const [x, y] = proj4(wgs84, vicGrid94, [lon, lat]);
      
      let scale = 8000016.000032;
      for (let i = 6; i < W.map.getZoom(); i++) {
        scale /= 2;
      }
      
      const mapURL = `https://mapshare.vic.gov.au/mapsharevic/?scale=${scale}&center=${x}%2C${y}`;
      if (W.map.getZoom() <= 5) {
        alert('Please zoom in to use this feature.');
      } else if (W.map.getZoom() >= 20) {
        alert('Please zoom out to use this feature.');
      } else {
        window.open(mapURL, '_blank');
      }

      //Prevent default a tag functionality
      return false;
    }

    function debug(message) {
      console.log(`${SCRIPT_NAME}: ${message}`);
    }

    bootstrap();
})();
