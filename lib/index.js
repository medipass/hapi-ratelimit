'use strict';

var Boom = require('boom');
var redis = require('redis');
var Hoek = require('hoek');
var Limiter = require('ratelimiter');

var internals = {};

internals.defaults = {
  namespace: 'clhr',
  global: {
    ip: {
      limit: -1,
      duration: 1
    },
    auth: {
      limit: -1,
      duration: 1
    }
  },
  redis: {}
};

var MILLISECONDS = 1000;

exports.name = 'hapi-ratelimit';

function extractClientIp(request) {
  var xFF = request.headers['x-forwarded-for'];
  return xFF ? xFF.split(',')[0] : request.info.remoteAddress;
}

exports.register = function(plugin, options, next) {
  var settings = Hoek.applyToDefaults(internals.defaults, options);
  var redisClient = redis.createClient(options.redis.port, options.redis.host, options.redis.options);

  function performLimit(request, reply, ipts, routeLimit) {
    var routeLimiter = new Limiter({
      id: ipts,
      db: redisClient,
      max: routeLimit.limit,
      duration: routeLimit.duration * MILLISECONDS
    });
    var error = null;
    routeLimiter.get(function(err, rateLimit) {
      if (err) {
        return reply(err);
      }
      request.plugins['hapi-ratelimit'] = {};
      request.plugins['hapi-ratelimit'].limit = rateLimit.total;
      request.plugins['hapi-ratelimit'].remaining = rateLimit.remaining - 1;
      request.plugins['hapi-ratelimit'].reset = rateLimit.reset;

      if (rateLimit.remaining <= 0) {
        error = Boom.tooManyRequests('Rate limit exceeded');
        error.output.headers['X-Rate-Limit-Limit'] = request.plugins['hapi-ratelimit'].limit;
        error.output.headers['X-Rate-Limit-Remaining'] = request.plugins['hapi-ratelimit'].remaining;
        error.output.headers['X-Rate-Limit-Reset'] = request.plugins['hapi-ratelimit'].reset;
        error.reformat();
        return reply(error);
      } else {
        return reply.continue();
      }
    });
  }

  // ip
  plugin.ext('onPreAuth', function(request, reply) {
    var route = request.route;
    var routeLimit = route.settings.plugins && route.settings.plugins['hapi-ratelimit'] && route.settings.plugins['hapi-ratelimit'].ip;
    if (!routeLimit && settings.global.ip.limit > 0) {
      routeLimit = settings.global.ip;
    }
    if (routeLimit) {
      var ipts = settings.namespace + ':' + extractClientIp(request) + ':' + route.method + ':' + route.path;
      performLimit(request, reply, ipts, routeLimit);
    } else {
      return reply.continue();
    }
  });

  // auth
  plugin.ext('onPostAuth', function(request, reply) {
    var route = request.route;
    var routeLimit = route.settings.plugins && route.settings.plugins['hapi-ratelimit'] && route.settings.plugins['hapi-ratelimit'].auth;
    if (!routeLimit && settings.global.auth.limit > 0) {
      routeLimit = settings.global.auth;
    }
    if (routeLimit) {
      var ipts = settings.namespace + ':' + Hoek.reach(request, routeLimit.idPath) + ':' + route.method + ':' + route.path;
      performLimit(request, reply, ipts, routeLimit);
    } else {
      return reply.continue();
    }
  });

  plugin.ext('onPostHandler', function(request, reply) {
    var response;
    if ('hapi-ratelimit' in request.plugins) {
      response = request.response;
      if (!response.isBoom) {
        response.headers['X-Rate-Limit-Limit'] = request.plugins['hapi-ratelimit'].limit;
        response.headers['X-Rate-Limit-Remaining'] = request.plugins['hapi-ratelimit'].remaining;
        response.headers['X-Rate-Limit-Reset'] = request.plugins['hapi-ratelimit'].reset;
      }
    }
    reply.continue();
  });
  next();
};

exports.register.attributes = {
  pkg: require('../package.json')
};
