/**
 * @fileoverview Aggregates the project-local `healthlog/*` ESLint rules
 * into a single plugin object for the flat config.
 *
 *   - `queryKey-factory`    — bare-array queryKey / mutationKey bypass guard.
 *   - `safe-fetch-required` — outbound fetch must route through safeFetch.
 */

"use strict";

const queryKeyFactory = require("./queryKey-factory.js");
const safeFetchRequired = require("./safe-fetch-required.js");

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactory.rules["queryKey-factory"],
    "safe-fetch-required": safeFetchRequired,
  },
};
