// Copyright 2012 Metricfire, Ltd.
// 
// Licensed under the Apache License, Version 2.0 (the "License"); 
// you may not use this file except in compliance with the License. 
// You may obtain a copy of the License at 
// 
// http://www.apache.org/licenses/LICENSE-2.0 
// 
// Unless required by applicable law or agreed to in writing, software 
// distributed under the License is distributed on an "AS IS" BASIS, 
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. 
// See the License for the specific language governing permissions and 
// limitations under the License.

var jsdom = require('jsdom');
var sprintf = require('sprintf').sprintf;
var metricfire = require('metricfire');
var timezoneJS = require('timezone-js/src/date');
var fs = require('fs');

var window = getWindow();

// Keep a hash of container IDs to highcharts Chart objects so we can
// call .destroy() on them later to prevent memory leaking.
var charts = {};

// Give jsdom's Element a function for calculating the bounding box.
jsdom.dom.level3.core.Element.prototype.getBBox = function () {
      if(this.textContent)
        return {width: this.textContent.length * 6.5, height: 14}
      else
         return {
	         x: elem.offsetLeft,
	         y: elem.offsetTop,
	         width: elem.offsetWidth,
	         height: elem.offsetHeight
         };
   };

function getWindow()
{
   var window = jsdom.jsdom().createWindow();
   var script = window.document.createElement('script');

	// Load scripts
   //jsdom.jQueryify(window, 'http://code.jquery.com/jquery-1.4.2.min.js', function(w,jq) {
   jsdom.jQueryify(window, 'file:///' + __dirname + '/jquery-1.7.1.js', function(w,jq) {
		var filename = 'file:///' + __dirname + '/highcharts-2.1.9.src.patched.js';
		script.src = filename;
		script.onload = function() {
         //window.ready = true;
		}
		window.document.body.appendChild(script);
	});

   // The IANA tzdata files should live in lib/tzdata/
   timezoneJS.timezone.zoneFileBasePath = __dirname + "/tzdata";

   // Prepare to load all the timezone rule files.
   timezoneJS.timezone.loadingScheme = timezoneJS.timezone.loadingSchemes.PRELOAD_ALL;
   timezoneJS.timezone.defaultZoneFile = ['africa','antarctica','asia','australasia','backward','etcetera','europe','factory','iso3166.tab','leapseconds','northamerica','pacificnew','solar87','solar88','solar89','southamerica','systemv','zone.tab'];

   // Replace the timezoneJS file loading function with one that will
   // use node's fs module to read from local paths.
   timezoneJS.timezone.transport = function(e){
         if(undefined === e.success)
         {
            // Synchronous read
            return fs.readFileSync(e.url, 'ascii');
         }
         else
         {
            // Asynchronous read
            var data = fs.readFile(e.url, function(err, data){
                  e.success(data.toString());
               });
         }
      };

   // Load timezone rule files.
   timezoneJS.timezone.init();

   return window;
}


function render(graphhash, reqbody, callback)
{
   var $	= window.jQuery;
   
   var container_id = "c_" + graphhash;

   // Try to locate an existing container for this graph.
   
   // We have to use a stupid, inefficient selector here because something
   // about this combination of nodejs, jsdom, jquery and highcharts
   // breaks the smarter #id selectors.
   //var selector = "#" + container_id;
   var selector = "body > div[id=" + container_id + "]";

   $container = window.jQuery(selector);

   if($container.length == 0)
   {
      // Create a new graph container.
		var $container= $('<div>');
      $container.attr('id', container_id);
      $container.attr('data-lastused', new Date().getTime());
      $container.attr('data-created', new Date().getTime());
	   $container.appendTo(window.document.body);

      // Override a bunch of options.
      reqbody.config.chart.renderTo = container_id;
      reqbody.config.chart.width = reqbody.width;
      reqbody.config.chart.height = reqbody.height;
      reqbody.config.chart.forExport = true;
      reqbody.config.chart.animation = false;
      if(undefined == reqbody.config.credits)
         reqbody.config.credits = {}
      reqbody.config.credits.enabled = true;
      reqbody.config.credits.text = "UPDATEDTIME";

      // Create a new chart.
	   try
      {
         var before = new Date().getTime();
         chart = charts[container_id] = new window.Highcharts.Chart(reqbody.config);
         metricfire.send("request.newchart", new Date().getTime() - before);
      } catch (e) {
         console.error(e);
  	      callback(e, null);
      }

      // Locate the credits text element, apply a class so we can find it
      // later and clear out the text in it.
      $container.find("text > tspan:contains('UPDATEDTIME')").attr('class', 'timestamp').text("");

   } else if($container.length == 1) {
      // Use the existing container and chart
      chart = charts[container_id];
      metricfire.send("request.cachedchart", 1);
   } else {
      // More than one container
      console.warn("Found more than one container for graph " + graphhash);
      
      // Prematurely age all the containers so they will be cleaned up earlier.
      $container.each(function(){
            $(this).attr('data-lastused', 0)
         });

      chart = charts[container_id];
   }

   // Update timestamp in the lower right corner.
   // Find the timezone offset.
   var now = new Date()
   try
   {
      var tzdata = timezoneJS.timezone.getTzInfo(now, reqbody.tz)
   } catch (err) {
      // If there was an error parsing the timezone, use UTC and try again.
      reqbody.tz = "UTC"
      var tzdata = timezoneJS.timezone.getTzInfo(now, reqbody.tz)
   }
   var updated = new Date(now - (tzdata.tzOffset * 60 * 1000))
   // This is a big dirty lie. The time is not UTC anymore since it was altered by the timezone offset.
   $container.find("tspan.timestamp").text(sprintf("Rendered at %02d:%02d:%02d %s", updated.getUTCHours(), updated.getUTCMinutes(), updated.getUTCSeconds(), tzdata.tzAbbr));

   //var delta = (new Date().getTime() - $container.attr('data-lastused')) / 1000;
   //console.log("Using container that was last used " + delta +" seconds ago.");
   //console.log($container.attr('id'));

   // Set the data on the chart.
   var before = new Date().getTime()
   for(var index in reqbody.data)
   {
      var timeshifted = [];
      for(var dataindex in reqbody.data[index])
      {
         var item = reqbody.data[index][dataindex];

         // Look up the timezone/DST offset of each datapoint.
         var tzdata = timezoneJS.timezone.getTzInfo(new Date(item[0]), reqbody.tz)
         
         // Modify each timestamp by the offset. It is no longer UTC.
         timeshifted.push([item[0] - (tzdata.tzOffset * 60 * 1000), item[1]]);
      }
      
      // Apply the modified data to the chart.
      chart.series[index].setData(timeshifted);
   }
   metricfire.send("request.setdata", new Date().getTime() - before);

   // Take the SVG generated by the chart and serve it to the user.
   svg = $container.children().html();
   callback(null, svg);
  
   // Update the time the container was last used.
   $container.attr('data-lastused', new Date().getTime());
}

function collectOldCharts()
{
   var $ = window.jQuery;
   $('body > div').each(function(){
      var delta = (new Date().getTime() - $(this).attr('data-lastused')) / 1000;

      // TODO Make this configurable
      if(delta > 30)
      {
         //console.log(sprintf("Freed container/chart (%s) that was last used %f seconds ago.", this.id, delta));
         charts[this.id].destroy();
         delete charts[this.id];
         $(this).remove();
         metricfire.send("request.chartremoved", 1);
      }
   });

   var memusage = process.memoryUsage();
   metricfire.send("memoryusage.rss", memusage.rss);
   metricfire.send("memoryusage.heaptotal", memusage.heapTotal);
   metricfire.send("memoryusage.heapused", memusage.heapUsed);
}

// TODO make this configurable
setInterval(collectOldCharts, 32 * 1000);

exports.render = render;
