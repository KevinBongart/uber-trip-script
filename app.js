var CAR_MAP, CONCURRENCY, LOGIN_URL, async, cheerio, config, downloadTrip, fs, login, moment, parseStats, path, request, requestTripList, startParsing, url, writeToFile, _;

fs = require('fs');

path = require('path');

url = require('url');

_ = require('underscore');

async = require('async');

request = require('request');

cheerio = require('cheerio');

moment = require('moment');

request = request.defaults({
  jar: true
});

CONCURRENCY = 3;

LOGIN_URL = 'https://login.uber.com/login';

config = require('./config.json');

CAR_MAP = {
  'uberx': 'UberX',
  'suv': 'UberSUV',
  'black': 'UberBlack',
  'uberblack': 'UberBlack',
  'taxi': 'Taxi'
};

writeToFile = function(filename, data) {
  filename = path.join('tmp', filename);
  return fs.writeFile(filename, data, function() {});
};

console.log('Requesting login page...');

request(LOGIN_URL, function(err, res, body) {

  var $, csrf;
  $ = cheerio.load(body);
  csrf = $('[name=_csrf_token]').val();

  return login(config.username, config.password, csrf);
});

login = function(user, pass, csrf) {
  var form;

  form = {
    'email': user,
    'password': pass,
    '_csrf_token': csrf,
    'redirect_to': 'riders',
    'redirect_url': 'https://riders.uber.com/trips',
    'request_source': 'www.uber.com'
  };
  console.log('Logging in as ' + user);
  return request.post(LOGIN_URL, {
    form: form
  }, function(err, res, body) {
    var redirectUrl, resp;
    if (err) {
      throw err;
    }

    redirectUrl = 'https://riders.uber.com/trips';
    return request(redirectUrl, function(err) {
      if (err) {
        throw err;
      }
      return startParsing();
    });
  });
};

requestTripList = function(page, cb) {
  var listUrl, options;
  listUrl = "https://riders.uber.com/trips?page=" + page;
  options = {
    url: listUrl,
    headers: {
      'x-ajax-replace': true
    }
  };
  console.log('Fetching', listUrl);
  return request(options, function(err, res, body) {
    writeToFile("list-" + page + ".html", body);
    return cb(err, body);
  });
};

startParsing = function() {
  var pagesToGet, _i, _ref, _results;
  console.log('Cool, logged in.');
  pagesToGet = (function() {
    _results = [];
    for (var _i = 1, _ref = config.tripPages; 1 <= _ref ? _i <= _ref : _i >= _ref; 1 <= _ref ? _i++ : _i--){ _results.push(_i); }
    return _results;
  }).apply(this);
  console.log('Getting pages', pagesToGet);
  return async.mapLimit(pagesToGet, CONCURRENCY, requestTripList, function(err, result) {
    var $, combined, tripIds, trips;
    if (err) {
      throw err;
    }
    console.log("Fetched all pages, got " + result.length + " results");
    combined = result.join(' ');
    writeToFile('lists-combined.html', combined);
    $ = cheerio.load(combined);
    trips = $('.trip-expand__origin');
    tripIds = trips.map(function(i, trip) {
      return $(trip).attr('data-target').slice(6);
    }).toArray();
    console.log(tripIds); //array of all trip IDs
    return async.map(tripIds, downloadTrip, function(err, results) {
      if (err) {
        throw err;
      }
      console.log('Finished downloading all trips');

      //parse results and remove those that were errors
      for (var i = results.length; i--;) {
        if (results[i] == "error") {
          results.splice(i, 1);
        }
      };

      var featureCollection = {
        type:"FeatureCollection",
        features:results
      };

      //return writeToFile('uberRideStats.json', JSON.stringify(featureCollection));
      return fs.writeFile('uberData.geojson', JSON.stringify(featureCollection));
    });
  });
};

downloadTrip = function(tripId, cb) {

  var tripUrl;
  tripUrl = "https://riders.uber.com/trips/" + tripId;
  console.log("Downloading trip " + tripId);
  return request(tripUrl, function(err, res, body) {
    if (err) {
      throw err;
    }
    writeToFile("trip-" + tripId + ".html", body);
    return parseStats(tripId, body, cb);
  });
};

parseStats = function(tripId, html, cb) {
  var $, $rating, imgSrc, rawJourney, stats, tripAttributes, urlParts;
  stats = {
   type:"Feature",
   properties:{},
   geometry:{
    type:"LineString"
   }
  };
  $ = cheerio.load(html);
  imgSrc = $('.img--full.img--flush').attr('src');
  if (imgSrc) {
    urlParts = url.parse(imgSrc, true);

    if (urlParts.query.path) {
      rawJourney = urlParts.query.path.split('|').slice(2);
      stats.geometry.coordinates = _.map(rawJourney, function(pair) {
        var split = pair.split(',');
        split.reverse(); //x,y instead of y,x provided (lat,lon)
        split[0] = parseFloat(split[0]);
        split[1] = parseFloat(split[1]);
        return split;
      });
      stats.properties.fareCharged = $('.fare-breakdown tr:last-child td:last-child').text();
      stats.properties.fareTotal = $('.fare-breakdown tr.separated--top.weight--semibold td:last-child').text();
    
      $('.fare-breakdown tr').each(function(i, ele) {
        var $ele, col1, col2, col3, key, label, text1, text2, text3, value, _ref, _ref1;
        $ele = $(ele);
        _ref = $ele.find('td'), col1 = _ref[0], col2 = _ref[1], col3 = _ref[2];
        _ref1 = [$(col1).text(), $(col2).text(), $(col3).text()], text1 = _ref1[0], text2 = _ref1[1], text3 = _ref1[2];
        if (text1 && text2) {
          label = text1.toLowerCase();
          value = text2;
        } else if (text2 && text3) {
          label = text2.toLowerCase();
          value = text3;
        } else if (text1 && text3) {
          label = text1.toLowerCase();
          value = text3;
        }
        switch (label) {
          case 'base fare':
            key = 'fareBase';
            break;
          case 'distance':
            key = 'fareDistance';
            break;
          case 'time':
            key = 'fareTime';
            break;
          case 'subtotal':
            key = 'fareSubtotal';
            break;
          case 'uber credit':
            key = 'fareUberCredit';
        }
        if (label.indexOf('charged') > -1) {
          key = 'charged';
        }
        return stats.properties[key || label] = value;
      });
      tripAttributes = $('.trip-details__breakdown .soft--top .flexbox__item');
      tripAttributes.each(function(i, ele) {
        var $ele, key, label, value;
        $ele = $(ele);
        label = $ele.find('div').text().toLowerCase();
        value = $ele.find('h5').text();
        switch (label) {
          case 'car':
            key = 'car';
            value = CAR_MAP[value] || value;
            break;
          case 'miles':
            key = 'distance';
            break;
          case 'trip time':
            key = 'duration';
        }
        return stats.properties[key] = value;
      });
      $rating = $('.rating-complete');
      if ($rating) {
        stats.properties.rating = $rating.find('.star--active').length;
      }
      stats.properties.endTime = $('.trip-address:last-child p').text();
      stats.properties.startTime = $('.trip-address:first-child p').text();
      stats.properties.endAddress = $('.trip-address:last-child h6').text();
      stats.properties.startAddress = $('.trip-address:first-child h6').text();
      stats.properties.date = $('.page-lead div').text();
      stats.properties.driverName = $('.trip-details__review .grid__item:first-child td:last-child').text().replace('You rode with ', '');
      writeToFile("stats-" + tripId + ".json", JSON.stringify(stats));
      
    } else {stats = "error"};
    return cb(null, stats);
  } else {stats = "error"};
  return cb(null, stats);
};