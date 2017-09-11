"use strict";

var Lab = require(`lab`),
    async = require(`async`),
    sinon = require(`sinon`),
    Hoek = require(`hoek`),
    lab = exports.lab = Lab.script(),
    experiment = lab.experiment,
    before = lab.before,
    after = lab.after,
    test = lab.test,
    expect = require(`code`).expect,
    server;

var serverGenerator = require(`./mocks/server`);
var configs = {
  routes: require(`./configs/routes`),
  plugin: require(`./configs/plugin`)
};

var APISiteLimits = {
  rate_limits: {
    "API": [{
      name: `default`,
      ttl: 1000 * 60,
      limit: 5,
    },{
      name: `daily`,
      ttl: 1000 * 60 * 60 * 24,
      limit: 10000,
    }],
  },
};

var SiteLimits = {
  rate_limits: [{
    name: `default`,
    ttl: 1000 * 60,
    limit: 5,
  },{
    name: `daily`,
    ttl: 1000 * 60 * 60 * 24,
    limit: 10000,
  }],
};

experiment(`hapi-ratelimiter`, () => {
  function inject(expectedCode, limit, remaining) {
    return function(done) {
      server.inject({
        url: `/limited`
      }, (resp) => {
        expect(resp.statusCode).to.equal(expectedCode);
        expect(resp.headers[`x-rate-limit-limit`]).to.equal(limit);
        expect(resp.headers[`x-rate-limit-remaining`]).to.equal(remaining);
        expect(resp.headers[`x-rate-limit-reset`]).to.exist();
        done();
      });
    };
  }

  function injectWithSiteLimits(expectedCode, limit, remaining, siteLimits) {
    return function(done) {
      server.ext(`onRequest`, (request, reply) => {
        request.site = siteLimits || SiteLimits;
        return reply.continue();
      });
      server.inject({
        url: `/sitelimited`
      }, (resp) => {
        expect(resp.statusCode).to.equal(expectedCode);
        expect(resp.headers[`x-rate-limit-limit`]).to.equal(limit);
        expect(resp.headers[`x-rate-limit-remaining`]).to.equal(remaining);
        expect(resp.headers[`x-rate-limit-reset`]).to.exist();
        done();
      });
    };
  }

  experiment(`defaults to off`, () => {
    before((done) => {
      serverGenerator(configs.plugin.offByDefault, configs.routes.offByDefault, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`Routes are not rate limited by default`, (done) => {
      server.inject({
        url: `/limited`
      }, (resp) => {
        expect(resp.request.plugins[`hapi-ratelimiter`]).to.not.exist();
        done();
      });
    });
  });

  experiment(`default settings`, () => {
    before((done) => {
      serverGenerator(configs.plugin.defaults, configs.routes.defaults, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies default settings`, (done) => {
      async.series([
        inject(200, 15, 14),
        inject(200, 15, 13),
        inject(200, 15, 12),
        inject(200, 15, 11),
        inject(200, 15, 10),
        inject(200, 15, 9),
        inject(200, 15, 8),
        inject(200, 15, 7),
        inject(200, 15, 6),
        inject(200, 15, 5),
        inject(200, 15, 4),
        inject(200, 15, 3),
        inject(200, 15, 2),
        inject(200, 15, 1),
        inject(200, 15, 0),
        inject(429, 15, 0)
      ], () => {
        done();
      });
    });
  });

  experiment(`global plugin settings`, () => {
    before((done) => {
      serverGenerator(configs.plugin.customSettings, configs.routes.defaults, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies custom settings`, (done) => {
      async.series([
        inject(200, 5, 4),
        inject(200, 5, 3),
        inject(200, 5, 2),
        inject(200, 5, 1),
        inject(200, 5, 0),
        inject(429, 5, 0)
      ], () => {
        done();
      });
    });
  });

  experiment(`handles more complex settings`, () => {
    before((done) => {
      serverGenerator(configs.plugin.complexSettings, configs.routes.defaults, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies complex settings`, (done) => {
      async.series([
        inject(200, `5,720`, `4,719`),
        inject(200, `5,720`, `3,718`),
        inject(200, `5,720`, `2,717`),
        inject(200, `5,720`, `1,716`),
        inject(200, `5,720`, `0,715`),
        inject(429, 5, 0)
      ], () => {
        done();
      });
    });
  });

  experiment(`handles site settings added to request object`, () => {
    before((done) => {
      serverGenerator(configs.plugin.defaults, configs.routes.siteLimited, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies site settings`, (done) => {
      async.series([
        injectWithSiteLimits(200, `5,10000`, `4,9999`),
        injectWithSiteLimits(200, `5,10000`, `3,9998`),
        injectWithSiteLimits(200, `5,10000`, `2,9997`),
        injectWithSiteLimits(200, `5,10000`, `1,9996`),
        injectWithSiteLimits(200, `5,10000`, `0,9995`),
        injectWithSiteLimits(429, 5, 0),
      ], () => {
        done();
      });
    });
  });

  experiment(`handles site settings with route type`, () => {
    before((done) => {
      serverGenerator(configs.plugin.APIRouteType, configs.routes.siteLimited, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies site settings`, (done) => {
      async.series([
        injectWithSiteLimits(200, `5,10000`, `4,9999`, APISiteLimits),
        injectWithSiteLimits(200, `5,10000`, `3,9998`, APISiteLimits),
        injectWithSiteLimits(200, `5,10000`, `2,9997`, APISiteLimits),
        injectWithSiteLimits(200, `5,10000`, `1,9996`, APISiteLimits),
        injectWithSiteLimits(200, `5,10000`, `0,9995`, APISiteLimits),
        injectWithSiteLimits(429, 5, 0, APISiteLimits),
      ], () => {
        done();
      });
    });

    test(`does not apply site-wide settings to routes with a type specified`, (done) => {
      async.series([
        injectWithSiteLimits(200, 15, 14, SiteLimits),
        // Now test with rate_limits set improperly
        injectWithSiteLimits(200, 15, 13, `Not an array of limits`),
      ], () => {
        done();
      });
    });
  });

  experiment(`route overrides`, () => {
    before((done) => {
      serverGenerator(configs.plugin.customSettings, configs.routes.overrides, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`applies route override settings`, (done) => {
      async.series([
        inject(200, 5, 4),
        inject(200, 5, 3),
        inject(200, 5, 2),
        inject(200, 5, 1),
        inject(200, 5, 0),
        inject(429, 5, 0)
      ], () => {
        done();
      });
    });
  });

  experiment(`x-forwarded-for`, () => {
    before((done) => {
      serverGenerator(configs.plugin.defaults, configs.routes.defaults, (s) => {
        server = s;
        done();
      });
    });

    after((done) => {
      server.stop(done);
    });

    test(`uses xff header if available`, (done) => {
      server.inject({
        url: `/limited`,
        headers: {
          'x-forwarded-for': `0.0.0.0`
        }
      }, (resp) => {
        expect(resp.statusCode).to.equal(200);
        expect(resp.headers[`x-rate-limit-limit`]).to.equal(15);
        expect(resp.headers[`x-rate-limit-remaining`]).to.equal(14);
        expect(resp.headers[`x-rate-limit-reset`]).to.exist();
        done();
      });
    });
  });

  experiment(`handles error from cache client`, () => {
    experiment(`cache client get`, () => {
      before((done) => {
        var config = Hoek.applyToDefaults(configs.plugin.defaults, {
          cacheClient: {
            get: sinon.stub().callsArgWith(1, new Error(`mock error`))
          }
        });

        serverGenerator(config, configs.routes.defaults, (s) => {
          server = s;
          done();
        });
      });

      after((done) => {
        server.stop(done);
      });

      test(`uses xff header if available`, (done) => {
        server.inject({
          url: `/limited`
        }, (resp) => {
          expect(resp.statusCode).to.equal(500);
          done();
        });
      });
    });

    experiment(`cache client set (new cache record)`, () => {
      before((done) => {
        var config = Hoek.applyToDefaults(configs.plugin.defaults, {
          cacheClient: {
            get: sinon.stub().callsArgWith(1, null, null),
            set: sinon.stub().callsArgWith(3, new Error(`mock error`))
          }
        });

        serverGenerator(config, configs.routes.defaults, (s) => {
          server = s;
          done();
        });
      });

      after((done) => {
        server.stop(done);
      });

      test(`returns 500`, (done) => {
        server.inject({
          url: `/limited`
        }, (resp) => {
          expect(resp.statusCode).to.equal(500);
          done();
        });
      });
    });

    experiment(`cache client set (update cache record)`, () => {
      before((done) => {
        var config = Hoek.applyToDefaults(configs.plugin.defaults, {
          cacheClient: {
            get: sinon.stub().callsArgWith(1, null, { remaining: 2 }, { ttl: 6000 }),
            set: sinon.stub().callsArgWith(3, new Error(`mock error`))
          }
        });

        serverGenerator(config, configs.routes.defaults, (s) => {
          server = s;
          done();
        });
      });

      after((done) => {
        server.stop(done);
      });

      test(`returns 500`, (done) => {
        server.inject({
          url: `/limited`
        }, (resp) => {
          expect(resp.statusCode).to.equal(500);
          done();
        });
      });
    });
  });
});
