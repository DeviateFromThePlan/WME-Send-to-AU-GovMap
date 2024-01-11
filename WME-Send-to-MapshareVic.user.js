// ==UserScript==
// @name         WME Send to MapshareVic
// @namespace    http://www.example.com
// @version      2024.01.11.02
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

    // Function to open MapshareVic with the coordinates at the center of the screen
    function openMapshareVic() {

      const center = WazeWrap.Geometry.ConvertTo4326(W.map.getCenter().lon, W.map.getCenter().lat);
      console.log(center);
      const latitude = center.lat;
      const longitude = center.lon;

      const wgs84 = '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs';
      const vicGrid94 = '+proj=tmerc +lat_0=-37 +lon_0=145 +k=1 +x_0=2500000 +y_0=2500000 +ellps=GRS80 +units=m +no_defs';

      let initialValue = 8000016.000032;
        function mapscale(increaseAmount) {
            for (let i = 6; i < increaseAmount; i++) {
            initialValue /= 2;
            }
            return initialValue;
        }

      const result = proj4(wgs84, vicGrid94, [longitude, latitude]);

      const mapshareVicURL = `https://mapshare.vic.gov.au/mapsharevic/?scale=${mapscale(W.map.getZoom())}&center=${result[0]}%2C${result[1]}`;
      console.log(mapshareVicURL);

        if(W.map.getZoom()<=5){alert('Please zoom in to use this feature.');}else if(W.map.getZoom()>=20){alert('Please zoom out to use this feature.');}else{window.open(mapshareVicURL, '_blank');}

    }

    // Function to handle the keydown event
    function handleKeyDown(event) {
        // Check if the pressed key is 'G'
        if (event.key === 'G' || event.key === 'g') {
            openMapshareVic();
        }
    }

    // Add keydown event listener to the document
    document.addEventListener('keydown', handleKeyDown);

})();
