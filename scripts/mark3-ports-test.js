#!/usr/bin/env node
'use strict';

// Regression tests for capabilities ported from FatihMakes/Mark-LIII
// (MIT-compatible concept port — reimplemented for GemAir's own tool-calling
// engine, memory store and risk-gating, no upstream code copied):
//   - Background topic monitor (proactive daily headline watcher)
//   - Flight finder (keyless: pre-filled live Google Flights search)
//   - Game updater (Steam/Epic deep-link update trigger)
//
// This is a pure-Node test: no Electron dependency, no network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const backgroundMonitor = require(path.join(ROOT, 'lib/background-monitor.js'));
const flightFinder = require(path.join(ROOT, 'lib/flight-finder.js'));
const gameUpdater = require(path.join(ROOT, 'lib/game-updater.js'));

console.log('\nGemAir — Mark-LIII ported tools regression tests\n');

// ---------------------------------------------------------------------------
// Background Monitor
// ---------------------------------------------------------------------------
{
  const mem = { monitors: [] };
  const added = backgroundMonitor.addMonitor(mem, 'iPhone 17 launch');
  assert(added.ok, 'adding a normal topic should succeed');
  assert.strictEqual(mem.monitors.length, 1, 'monitor should be stored');

  const dup = backgroundMonitor.addMonitor(mem, 'iphone 17 launch');
  assert(dup.ok && dup.alreadyMonitoring, 're-adding the same topic should be idempotent, not duplicated');
  assert.strictEqual(mem.monitors.length, 1, 'duplicate topic must not create a second entry');

  const blocked = backgroundMonitor.addMonitor(mem, 'Bitcoin price prediction');
  assert(blocked.error, 'crypto/finance topics must be refused');

  const list = backgroundMonitor.listMonitors(mem);
  assert.strictEqual(list.length, 1, 'list should reflect stored monitors');

  const removed = backgroundMonitor.removeMonitor(mem, 'iPhone 17');
  assert(removed.ok, 'partial-match removal should succeed');
  assert.strictEqual(mem.monitors.length, 0, 'monitor should be gone after removal');

  const missing = backgroundMonitor.removeMonitor(mem, 'nonexistent topic');
  assert(missing.error, 'removing an unknown topic should error, not silently succeed');

  console.log('  ok   background monitor: add / dedupe / crypto-block / list / remove');
}

// checkMonitors: throttling + change detection, with an injected fetch stub
(async () => {
  const mem = { monitors: [] };
  backgroundMonitor.addMonitor(mem, 'Formula 1');
  mem.monitors[0].lastCheck = 0; // force due

  let calls = 0;
  const fetchStub = async () => { calls++; return { title: 'Race postponed', url: 'https://example.com/f1', source: 'Example' }; };

  const firstAlerts = await backgroundMonitor.checkMonitors(mem, fetchStub, { force: false });
  assert.strictEqual(firstAlerts.length, 1, 'a brand-new headline should raise exactly one alert');
  assert.strictEqual(calls, 1, 'fetch should be called once for the due topic');

  const secondAlerts = await backgroundMonitor.checkMonitors(mem, fetchStub, { force: false });
  assert.strictEqual(secondAlerts.length, 0, 'checking again same day (same headline) must not re-alert');
  assert.strictEqual(calls, 1, 'a topic checked within the last 24h must not be re-fetched');

  const forcedAlerts = await backgroundMonitor.checkMonitors(mem, fetchStub, { force: true });
  assert.strictEqual(forcedAlerts.length, 0, 'forcing a re-check with an unchanged headline should not alert again');
  assert.strictEqual(calls, 2, 'force=true must bypass the once-a-day throttle');

  console.log('  ok   background monitor: once-a-day throttle + only-on-change alerting');
})().then(() => {
  // -------------------------------------------------------------------------
  // Flight Finder
  // -------------------------------------------------------------------------
  const now = new Date('2026-09-11T10:00:00Z');
  const flight = flightFinder.findFlights({ origin: 'Indore', destination: 'Delhi', date: 'tomorrow' }, now);
  assert(flight.ok, 'valid origin/destination/date should succeed');
  assert.strictEqual(flight.date, '2026-09-12', '"tomorrow" should resolve relative to the given clock');
  assert(flight.url.startsWith('https://www.google.com/travel/flights?q='), 'must build a real Google Flights URL');
  assert(!/api[_-]?key|token=/.test(flight.url), 'flight URL must not leak any credential-shaped query param');

  const isoFlight = flightFinder.findFlights({ origin: 'Mumbai', destination: 'London', date: '2027-01-05', returnDate: '2027-01-20', cabin: 'business' }, now);
  assert.strictEqual(isoFlight.date, '2027-01-05', 'ISO dates should pass through unchanged');
  assert.strictEqual(isoFlight.returnDate, '2027-01-20', 'return date should be parsed');
  assert(isoFlight.url.includes('Business'), 'cabin class should be reflected in the query');

  const badDate = flightFinder.findFlights({ origin: 'A', destination: 'B', date: 'not-a-real-date-xyz' }, now);
  assert(badDate.error, 'an unparseable date must produce a clear error, not a bad request');

  const missingFields = flightFinder.findFlights({ origin: 'A' }, now);
  assert(missingFields.error, 'missing destination/date must be rejected');

  console.log('  ok   flight finder: date parsing (relative/ISO), URL building, validation');

  // -------------------------------------------------------------------------
  // Game Updater
  // -------------------------------------------------------------------------
  const knownGame = gameUpdater.resolveSteamAppId('cyberpunk 2077');
  assert(knownGame && knownGame.appId === '1091500', 'known Steam titles should resolve to their App ID');

  const steamNamed = gameUpdater.updateGame({ launcher: 'steam', name: 'GTA V' });
  assert(steamNamed.ok && steamNamed.uri === 'steam://run/271590', 'named Steam game should build a steam://run/<appid> URI');

  const steamUnknown = gameUpdater.updateGame({ launcher: 'steam', name: 'some totally made up game xyz' });
  assert(steamUnknown.ok && steamUnknown.uri === gameUpdater.STEAM_OPEN_LIBRARY_URI, 'unrecognized Steam title should gracefully fall back to opening the library');

  const steamAll = gameUpdater.updateGame({ launcher: 'steam' });
  assert(steamAll.ok && steamAll.uri === gameUpdater.STEAM_OPEN_LIBRARY_URI, 'no game name should open the Steam library (checks everything)');

  const badLauncher = gameUpdater.updateGame({ launcher: 'origin' });
  assert(badLauncher.error, 'unsupported launcher should be rejected');

  console.log('  ok   game updater: Steam App ID resolution + deep-link URI building + validation');

  // -------------------------------------------------------------------------
  // Wiring into main.js: tool declarations, risk levels, dispatch, IPC
  // -------------------------------------------------------------------------
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  for (const tool of ['find_flights', 'update_game', 'list_installed_epic_games', 'add_topic_monitor', 'remove_topic_monitor', 'list_topic_monitors', 'check_topic_monitors']) {
    assert(mainSrc.includes(`name: '${tool}'`), `TOOLS declaration missing for ${tool}`);
    assert(mainSrc.includes(`case '${tool}':`), `executeToolNow dispatch missing for ${tool}`);
  }
  assert(/find_flights: 'safe'/.test(mainSrc), 'find_flights must have an explicit risk level');
  assert(/add_topic_monitor: 'safe'/.test(mainSrc), 'add_topic_monitor must have an explicit risk level');
  assert(mainSrc.includes("require('./lib/background-monitor')"), 'main.js must wire lib/background-monitor.js');
  assert(mainSrc.includes("require('./lib/flight-finder')"), 'main.js must wire lib/flight-finder.js');
  assert(mainSrc.includes("require('./lib/game-updater')"), 'main.js must wire lib/game-updater.js');
  assert(mainSrc.includes('startTopicMonitorScheduler'), 'proactive monitor scheduler must be registered at startup');
  assert(mainSrc.includes("mainWindow.webContents.send('monitor:alert'"), 'monitor alerts must be pushed to the renderer');
  console.log('  ok   main.js: tool declarations, risk levels, dispatch cases, and scheduler wired');

  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert(preloadSrc.includes("onTopicMonitorAlert"), 'preload must expose onTopicMonitorAlert');
  const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  assert(appSrc.includes('onTopicMonitorAlert'), 'renderer must subscribe to topic monitor alerts');
  console.log('  ok   preload + renderer: topic monitor alert channel is wired end to end');

  console.log('\nAll Mark-LIII port checks passed.\n');
}).catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
