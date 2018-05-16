
var Hoek = require(`hoek`);
var boom = require(`boom`);
var hapiLimiter = `hapi-limiter`;


var internals = {
  defaults: {
    cache: {
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


function handleCheckResult(request, h){
  return function(results){
    let error = results.find(r => r instanceof Error);

    if (error) {
      return error;
    }

    decorateRequestWithLimits(request, results);
    return h.continue;
  };
}


function checkLimit(redis){
  return async function(l){
    // l = { <int>limit, <int>ttl, <string>redisKey }
    // Check limit object `l` in redis for limit violation (remaining requests < 1);
    // and set limit key in redis with number of requests remaining.

    const tempKey = l.redisKey + `:temp`;
    const realKey = l.redisKey;
    const ttlseconds = l.ttl / 1000;

    const results = await redis.multi()
      .setex(tempKey, ttlseconds, 0)
      .renamenx(tempKey, realKey)
      .incr(realKey)
      .ttl(realKey)
      .execAsync();

    // automatically recover from possible race condition
    if (results[3] === -1) {
      redis.expire(realKey, ttlseconds);
    }
    // value starts at 0
    const value = results[2] + 1,
          limit = l.limit,
          reset = Date.now() + l.ttl,
          remaining = limit - value;

    if ( value > limit ) {
      const message = `Rate Limit Exceeded`;
      const error = boom.tooManyRequests(message);

      error.output.headers[`X-Rate-Limit-Limit`] = l.limit;
      error.output.headers[`X-Rate-Limit-Reset`] = reset;
      error.output.headers[`X-Rate-Limit-Remaining`] = 0;
      error.reformat();
      return error;
    }
    return { limit, remaining, reset };
  };
}


async function register(server, options) {
  const globalSettings = Hoek.applyToDefaults(internals.defaults, options);
  const cache = options.cache;
  const checkCachedLimit = checkLimit(cache);

  server.ext(`onPreHandler`, async (request, h) => {
    const routePlugins = request.route.settings.plugins;
    const handler = handleCheckResult(request, h);
    let result, results;

    if (
      !routePlugins[hapiLimiter] ||
      !routePlugins[hapiLimiter].enable
    ) {
      return h.continue;
    }
    const pluginSettings = Hoek.applyToDefaults(globalSettings, routePlugins[hapiLimiter]);
    // if this site/organization has limits defined, check those
    let siteLimits = (request.site && request.site.rate_limits);

    if (siteLimits){
      let limits = [];

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
        results = await Promise.all(limits.map(checkCachedLimit));
        return handler(results);
      }
    }

    if (pluginSettings.limits && pluginSettings.limits.constructor === Array){
      // If there were no organization-specific limits, apply global/plugin settings defined on this route
      // Don't bother with `route_type`, since pluginSettings are specified directly on the route(s)
      addRedisKey(pluginSettings.generateKeyFunc, request, null, pluginSettings.limits);
      results = await Promise.all(pluginSettings.limits.map(checkCachedLimit));
      return handler(results);
    }

    // else there will be a simple limit and ttl defined on the plugin settings by default above, use that
    result = await checkCachedLimit({
      limit: pluginSettings.limit,
      ttl: pluginSettings.ttl,
      redisKey: pluginSettings.generateKeyFunc(request, `default`),
    });
    return handler([ result ]);
  });

  server.ext(`onPostHandler`, async (request, h) => {
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

    return h.continue;
  });
}

exports.plugin = {
  pkg: require(`./package.json`),
  register: register,
};
