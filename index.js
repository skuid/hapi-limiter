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
    },{
      name: `daily`,
      limit: 720,
      ttl: 1000 * 60 * 60 * 24,
    }], */
    // default, single limit on the route
    limit: 15,
    ttl: 1000 * 60 * 15,

    generateKeyFunc: function(request, name) {
      var key = [];

      key.push(name);
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
          remaining,
          reset,
          keyValue = pluginSettings.generateKeyFunc(request, name);

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

    if (pluginSettings.limits && pluginSettings.limits.constructor === Array){
      // using async, do parallel check of all limits. If any fails, reply(err).
      return async.each(pluginSettings.limits, checkLimit, handleCheckResult);
    }

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
