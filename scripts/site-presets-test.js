#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { SITE_PRESETS, resolveSitePreset } = require('../lib/site-presets');
const windowTools = require('../lib/window-tools');

assert.strictEqual(resolveSitePreset('YouTube'), 'https://youtube.com');
assert.strictEqual(resolveSitePreset('spotify'), 'https://open.spotify.com');
assert.strictEqual(resolveSitePreset('focusarx'), 'https://focusarx.site');
assert.strictEqual(resolveSitePreset('not-a-platform'), null);
assert(Object.keys(SITE_PRESETS).length >= 20, 'platform catalog should contain useful presets');
assert.strictEqual(typeof windowTools.openSite, 'function');
console.log('ok - named platform destinations resolve without pasted URLs');
