/**
 * GemAir — Node-side entry point for the model currency ledger.
 *
 * The ledger itself lives at `renderer/model-currency.js` because that is the
 * directory the web deployment serves statically; it is written as a UMD-ish
 * module so the SAME file loads in a <script> tag (window.GemAirModelCurrency)
 * and through require() here. One copy means the desktop app, the serverless
 * free chain and the browser picker can never disagree about which model IDs
 * are alive.
 *
 * @see renderer/model-currency.js
 */
'use strict';

const path = require('path');

function load() {
  try {
    return require(path.join(__dirname, '..', 'renderer', 'model-currency.js'));
  } catch (error) {
    if (error && /Cannot find module/.test(String(error.message))) {
      throw new Error(
        'GemAir: renderer/model-currency.js is missing — the model currency ledger could not be loaded. '
        + 'Restore it (it ships with the app and the web build) before starting.'
      );
    }
    throw error;
  }
}

module.exports = load();
