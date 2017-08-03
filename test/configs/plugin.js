"use strict";

exports.offByDefault = {};
exports.defaults = {};
exports.customSettings = {
  ttl: 5000,
  limit: 5,
  cache: {
    cache: `test-cache`,
    segment: `custom-segment`
  }
};

exports.complexSettings = {
  limits: [{
    name: `default`,
    limit: 5,
    ttl: 5000,
  },{
    name: `daily`,
    limit: 720,
    ttl: 1000 * 60 * 60 * 24,
  }],
  cache: {
    cache: `test-cache`,
    segment: `complex-segment`
  }
};

exports.APIRouteType = {
  route_type: `API`,
};
