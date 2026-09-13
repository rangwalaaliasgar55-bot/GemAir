'use strict';

const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync('renderer/app.js', 'utf8');
const html = fs.readFileSync('renderer/index.html', 'utf8');
const css = fs.readFileSync('renderer/style.css', 'utf8');
const main = fs.readFileSync('main.js', 'utf8');
const preload = fs.readFileSync('preload.js', 'utf8');

assert(html.includes('id="globeCanvas"'), 'world globe canvas is missing');
assert(html.includes('id="worldLocateBtn"'), 'locate button is missing');
assert(html.includes('id="worldLocationStatus"'), 'location status is missing');
assert(app.includes('navigator.geolocation.getCurrentPosition'), 'precise location request is missing');
assert(app.includes('Coordinates are not saved'), 'the UI must disclose that exact coordinates are not persisted');
assert(app.includes("exact: true"), 'precise location marker is missing');
assert(app.includes("source: 'profile-city'"), 'coarse profile-city fallback is missing');
assert(css.includes('.world-location-status'), 'location status styling is missing');
assert(preload.includes("webGet: (kind, params) => ipcRenderer.invoke('web:get'"), 'desktop web bridge is missing');
assert(main.includes("ipcMain.handle('web:get'"), 'desktop web handler is missing');
console.log('globe-location-test: all assertions passed');
