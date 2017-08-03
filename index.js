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
    // to allow for multiple limit windows.
    // Route headers will contain values based on `name: "default"`.
    /* limits: [{
      name: `default`,
      limit: 5,
      ttl: 5000,
      route_type: "API",
    },{
      name: `daily`,
      limit: 720,
      ttl: 1000 * 60 * 60 * 24,
      route_type: "API"
    },{
      name: `default`,
      limit: 50,
      ttl: 5000,
      route_type: "UI",
    },{
      name: `daily`,
      limit: 7200,
      ttl: 1000 * 60 * 60 * 24,
      route_type: "UI"
    }], */
    // default, single limit on the route
    limit: 15,
    ttl: 1000 * 60 * 15,

    generateKeyFunc: function(request, name, type) {
      var key = [];

      key.push(name);
      key.push(type);
      key.push(request.method);
      key.push(request.path);
      var ip = request.headers[`x-forwarded-for`] || request.info.remoteAddress;

      key.push(ip);

      return key.join(`:`);
    }
  }
};


exports.register = function(server, options, done) {
  var globalSettings = Hoek.applyToDefaults(internals.defaults, options);

  var cacheClient = globalSettings.cacheClient;

  if ( !cacheClient ) {
    cacheClient = server.cache(globalSettings.cache);
  }

  server.ext(`onPreHandler`, (request, reply) => {
    var routePlugins = request.route.settings.plugins;

    if (
      !routePlugins[hapiLimiter] ||
      !routePlugins[hapiLimiter].enable
    ) {
      return reply.continue();
    }
    var pluginSettings = Hoek.applyToDefaults(globalSettings, routePlugins[hapiLimiter]);

    request.plugins[hapiLimiter] = {};

    function checkLimit(l, callback){
      let limit = l.limit,
          ttl = l.ttl,
          name = l.name,
          type = l.route_type,
          remaining,
          reset,
          keyValue = pluginSettings.generateKeyFunc(request, name, type);

      if (name === `default`){
        request.plugins[hapiLimiter].limit = limit;
      }
      cacheClient.get(keyValue, (err, value, cached) => {
        if ( err ) { return callback(err); }

        if ( !cached ) {
          return cacheClient.set(keyValue, { remaining: limit - 1 }, ttl, (cerr) => {
            if ( cerr ) { return callback(cerr); }
            if (name === `default`){
              request.plugins[hapiLimiter].remaining = limit - 1;
              reset = Date.now() + ttl;
              request.plugins[hapiLimiter].reset = reset;
            }
            return callback();
          });
        }
        remaining = value.remaining - 1;
        reset = Date.now() + cached.ttl;
        if (name === `default`){
          request.plugins[hapiLimiter].reset = reset;
          request.plugins[hapiLimiter].remaining = remaining;
        }

        if ( remaining < 0 ) {
          let error = boom.tooManyRequests(`Rate Limit Exceeded`);

          error.output.headers[`X-Rate-Limit-Limit`] = limit;
          error.output.headers[`X-Rate-Limit-Reset`] = reset;
          error.output.headers[`X-Rate-Limit-Remaining`] = 0;
          error.reformat();
          return callback(error);
        }
        return cacheClient.set(keyValue, { remaining: remaining }, cached.ttl, callback);
      });
    }

    function handleCheckResult(err){
      if (err){
        return reply(err);
      }
      reply.continue();
    }

    // if this site/organization has limits defined, check those
    let siteLimits = (request.site && request.site.rate_limits && request.site.rate_limits.constructor === Array);

    if (siteLimits){
      // e.g.: [{limit: 10, ttl: 1000, name: "default", route_type: "API"}, {limit: 100, ttl: 10000, name: "default", route_type: "UI"}]
      let limits = [];

      if (pluginSettings.route_type) {
        // if a route type is assigned to this route, apply those limits
        limits = request.site.rate_limits.filter(l => l.route_type === pluginSettings.route_type);
      } else {
        // if there is no route type assigned to this route, see if there are "general" limits for this organization
        limits = request.site.rate_limits.filter(l => !l.route_type);
      }
      if (limits.length > 0){
        return async.each(limits, checkLimit, handleCheckResult);
      }
    }

    if (pluginSettings.limits && pluginSettings.limits.constructor === Array){
      // If there were no organization-specific limits, apply global/plugin settings defined on this route
      // Don't bother with `route_type`, since pluginSettings are specified directly on the route(s)
      return async.each(pluginSettings.limits, checkLimit, handleCheckResult);
    }

    // else there will be a simple limit and ttl defined on the plugin settings by default above, use that
    return checkLimit({
      limit: pluginSettings.limit,
      ttl: pluginSettings.ttl,
      name: `default`,
    }, handleCheckResult);
  });

  server.ext(`onPostHandler`, (request, reply) => {
    var pluginSettings = request.route.settings.plugins;
    var response;

    if (
      pluginSettings[hapiLimiter] &&
      pluginSettings[hapiLimiter].enable
    ) {
      response = request.response;
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
