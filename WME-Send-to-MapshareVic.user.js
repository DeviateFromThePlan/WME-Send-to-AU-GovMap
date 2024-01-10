// ==UserScript==
// @name         WME Send to MapshareVic
// @namespace    http://www.example.com
// @version      0.1
// @description  Opens MapshareVic with the coordinates at the center of the screen when G key is pressed in Waze Map Editor
// @author       DeviateFromThePlan, maporaptor, lacmacca & ChatGPT
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
      console.log('WME Send to MapshareVic: Initialising')
      
      let liveMapElement = document.getElementsByClassName('wz-map-ol-control-mouse-position')[0];
      let mapShareElement = document.createElement('a');
      mapShareElement.id = 'WME-MapShare';
      mapShareElement.classList.add('wz-map-black-link');
      mapShareElement.innerText = 'MapShareVic';
      mapShareElement.onclick = openMapshareVic;

      liveMapElement.parentNode.insertBefore(mapShareElement, liveMapElement.nextSibling)

      // Add keydown event listener to the document
      document.addEventListener('keydown', handleKeyDown);
      
    }

    // Function to open MapshareVic with the coordinates at the center of the screen
    function openMapshareVic() {

      const center = WazeWrap.Geometry.ConvertTo4326(W.map.getCenter().lon, W.map.getCenter().lat);
      console.log(center);
      const latitude = center.lat;
      const longitude = center.lon;

      if (isNaN(latitude) || isNaN(longitude)) {
        alert('Please enter valid coordinates.');
        return;
      }

      const wgs84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs';
      const vicGrid94 = '+proj=tmerc +lat_0=-37 +lon_0=145 +k=1 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs';

      const result = proj4(wgs84, vicGrid94, [longitude, latitude]);

      const mapshareVicURL = `https://mapshare.vic.gov.au/mapsharevic/?layerTheme=5&scale=2500.0050000100005&basemap=&center=${result[0]}%2C${result[1]}&layers=2%2F7Gju1qBv%2BE1exh5B2NZLPj1qBv%2BE1exh5B1a%2BrRU1EVCLt2SXAYx3g4gTK13pw%2F029RVFg3ufR7i1wHZ9P0pYRq429RVFg3ufR7i2NfjBl0v7KKo29RVFg0Ko5nx3ufR7i3XikB52JwOVQ37%2FQbT106z6X3ufR7i1Pocd100UxYK0uOsFn3APQpP3ufR7i2JwOVQ37%2FQbT3ufR7i2AAqMk1%2F7fnZ2SSAmV2dVLLg29THcp0esJt%2B1%2FvUij0Vh2uR26cIi%2B3uMwRb2TrpCK0wDgJ31Pocd120PgDf02oG%2F11MMMvH1qudLY1qy8pc3B5WKq1KMHS42KTwsK2g5CGb2t%2BJ931Bsloz0YFTf02Zt2Hh1CbU%2FB3S%2BNWC3T1u%2BD1nlgj30eqOPw3ZK6Qz0eKbZP1CcYxN2k2fBh3bvmsT1Pocd13MqwBP2FfPi635e37h03Tvxs3kPWGd03Tvip3kPW1a3kPVoY0SVzxl2wjUgm0rbD5H38g47r3u5s6T2E3%2Bmf3wkeFu2VQLjy3JKLoy`;
      console.log(mapshareVicURL);

        window.open(mapshareVicURL, '_blank');

      return false;
    }

    // Function to handle the keydown event
    function handleKeyDown(event) {
        // Check if the pressed key is 'G'
        if (event.key === 'G' || event.key === 'g') {
            openMapshareVic();
        }
    }

    bootstrap();
})();
