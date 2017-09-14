"use strict";

var Hoek = require(`hoek`);
var boom = require(`boom`);
var async = require(`async`);
var hapiLimiter = `hapi-limiter`;

var internals = {
  defaults: {
    cache: {
      // https://github.com/hapijs/catbox?ts=2#policy
      expiresIn: 1000 * 60 * 60 * 24,
      segment: hapiLimiter
    },
    // Modified from https://www.npmjs.com/package/hapi-limiter#configuration
    // to allow for multiple limit types and windows e.g.:
    /* limits: {
    "API": [{
      name: `burst`,
      limit: 5,
      ttl: 5000,
    },{
      name: `daily`,
      limit: 720,
      ttl: 1000 * 60 * 60 * 24,
      route_type: "API"
    }],
    "UI": [{
      name: `burst`,
      limit: 50,
      ttl: 5000,
    },{
      name: `daily`,
      limit: 7200,
      ttl: 1000 * 60 * 60 * 24,
    }]}, */
    // default, single limit on the route
    limit: 15,
    ttl: 1000 * 60 * 15,

    /**
     * Default function for generating a redis key for a particular limit. Can
     * be overridden by hapi server using the plugin. Uses IP address of request.
     * @param  {Object} request - Hapi request object
     * @param  {String} name    - Name of limit, e.g. "burst" or "daily"
     * @param  {String} type    - Route type to which this limit applies, e.g. "API" or "Auth"
     * @return {String}         - Redis key for particular limit
     */
    generateKeyFunc: function(request, name, type) {
      var key = [];

      key.push(name);
      key.push(request.method);
      key.push(request.path);
      if (type){
        key.push(type);
      }
      var ip = request.headers[`x-forwarded-for`] || request.info.remoteAddress;

      key.push(ip);

      return key.join(`:`);
    }
  }
};

const aj = (lim, key) => lim.constructor === Array ? lim.map(l => l[key]).join() : lim[key];

function addRedisKey(generateKeyFunc, limitreq, type, limits){
  limits.forEach(l => {
    l.redisKey = generateKeyFunc(limitreq, l.name, type);
  });
}


function decorateRequestWithLimits(request, limits){
  // Get or create an object on request.plugins to hold values used by 'onPostHandler'
  const p = request.plugins[hapiLimiter] || {};

  p.limit = aj(limits, `limit`);
  p.remaining = aj(limits, `remaining`);
  p.reset = aj(limits, `reset`);
  request.plugins[hapiLimiter] = p;
}


function handleCheckResult(request, reply){
  return function(err, results){
    if (err){
      return reply(err);
    }
    decorateRequestWithLimits(request, results);
    return reply.continue();
  };
}


function checkLimit(cacheClient){
  return function(l, callback){
    // l = { <int>limit, <int>ttl, <string>redisKey }
    // Check limit object `l` in redis for limit violation (remaining requests < 1);
    // and set limit key in redis with number of requests remaining.
    cacheClient.get(l.redisKey, (err, value, cached) => {
      if ( err ) { return callback(err); }
      const newlimit = {
        limit: l.limit,
        remaining: l.limit - 1,
        reset: Date.now() + l.ttl,
      };

      if ( !cached ) {
        return cacheClient.set(
          l.redisKey,
          { remaining: newlimit.remaining },
          l.ttl,
          cerr => callback(cerr, newlimit)
        );
      }
      newlimit.remaining = value.remaining - 1;
      newlimit.reset = Date.now() + cached.ttl;

      if ( newlimit.remaining < 0 ) {
        let error = boom.tooManyRequests(`Rate Limit Exceeded`);

        error.output.headers[`X-Rate-Limit-Limit`] = l.limit;
        error.output.headers[`X-Rate-Limit-Reset`] = newlimit.reset;
        error.output.headers[`X-Rate-Limit-Remaining`] = 0;
        error.reformat();
        return callback(error, newlimit);
      }

      return cacheClient.set(
        l.redisKey,
        { remaining: newlimit.remaining },
        cached.ttl,
        merr => callback(merr, newlimit)
      );
    });
  };
}


exports.register = function(server, options, done) {
  var globalSettings = Hoek.applyToDefaults(internals.defaults, options);

  var cacheClient = globalSettings.cacheClient;

  if ( !cacheClient ) {
    cacheClient = server.cache(globalSettings.cache);
  }

  const checkCachedLimit = checkLimit(cacheClient);

  server.ext(`onPreHandler`, (request, reply) => {
    const routePlugins = request.route.settings.plugins;

    if (
      !routePlugins[hapiLimiter] ||
      !routePlugins[hapiLimiter].enable
    ) {
      return reply.continue();
    }
    const pluginSettings = Hoek.applyToDefaults(globalSettings, routePlugins[hapiLimiter]);
    // if this site/organization has limits defined, check those
    let siteLimits = (request.site && request.site.rate_limits);
    let limits = [];

    if (siteLimits){
      if (pluginSettings.route_type) {
        // If a route type is assigned to this route, apply those limits.
        // (Allows configuring limits globally and only specifying "route_type" in plugin settings.)
        limits = request.site.rate_limits[pluginSettings.route_type];
      } else {
        // if there is no route type assigned to this route, see if there are "general" limits (no route type)
        limits = request.site.rate_limits.constructor === Array && request.site.rate_limits;
      }
      if (limits && limits.length > 0){
        addRedisKey(pluginSettings.generateKeyFunc, request, pluginSettings.route_type, limits);
        return async.map(limits, checkCachedLimit, handleCheckResult(request, reply));
      }
    }

    if (pluginSettings.limits && pluginSettings.limits.constructor === Array){
      // If there were no organization-specific limits, apply global/plugin settings defined on this route
      // Don't bother with `route_type`, since pluginSettings are specified directly on the route(s)
      addRedisKey(pluginSettings.generateKeyFunc, request, null, pluginSettings.limits);
      return async.map(pluginSettings.limits, checkCachedLimit, handleCheckResult(request, reply));
    }

    // else there will be a simple limit and ttl defined on the plugin settings by default above, use that
    return checkCachedLimit({
      limit: pluginSettings.limit,
      ttl: pluginSettings.ttl,
      redisKey: pluginSettings.generateKeyFunc(request, `default`),
    }, handleCheckResult(request, reply));
  });

  server.ext(`onPostHandler`, (request, reply) => {
    var pluginSettings = request.route.settings.plugins;
    var response;

    if (
      pluginSettings[hapiLimiter] &&
      pluginSettings[hapiLimiter].enable
    ) {
      // If response is Boom.<something>, then headers are on request.response.output
      response = request.response.output || request.response || { headers: [] };
      response.headers[`X-Rate-Limit-Limit`] = request.plugins[hapiLimiter].limit;
      response.headers[`X-Rate-Limit-Remaining`] = request.plugins[hapiLimiter].remaining;
      response.headers[`X-Rate-Limit-Reset`] = request.plugins[hapiLimiter].reset;
    }

    reply.continue();
  });

  done();
};

exports.register.attributes = {
  pkg: require(`./package.json`)
};
