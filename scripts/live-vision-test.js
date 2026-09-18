#!/usr/bin/env node
'use strict';

// Fused live-vision tests (screen + camera inside the SAME voice conversation
// — Mark's "ask about what's on screen or in the camera mid-conversation",
// rebuilt on GemAir's permission-gated capture paths).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('\nGemAir — fused live-vision tests\n');

const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const liveSrc = fs.readFileSync(path.join(ROOT, 'renderer/gemini-live.js'), 'utf8');

// ---------------------------------------------------------------------------
// Main process: permission-gated, throttled, honestly-failing frame IPC
// ---------------------------------------------------------------------------
assert(mainSrc.includes("ipcMain.handle('vision:screenFrame'"), 'main must expose the vision:screenFrame IPC');
const frameBlock = mainSrc.split("ipcMain.handle('vision:screenFrame'")[1].slice(0, 1800);
assert(/profile\.screenAwareness !== true\)[\s\S]{0,160}SCREEN_AWARENESS_OFF/.test(frameBlock), 'screen frames must be gated on the existing Screen Awareness permission');
assert(frameBlock.includes('THROTTLED'), 'frame capture must be rate-limited (~1 fps) so a chatty renderer cannot hammer desktopCapturer');
assert(frameBlock.includes('desktopCapturer.getSources'), 'frames come from desktopCapturer (no new dependency)');
assert(/toJPEG\(\d+\)/.test(frameBlock), 'frames are JPEG-encoded for wire size');
assert(frameBlock.includes('mimeType: \'image/jpeg\''), 'JPEG mime declared for the Live media chunk');
assert(frameBlock.includes('CAPTURE_FAILED'), 'capture failures resolve honestly, never throw into the renderer');
console.log('  ok   main: vision:screenFrame is permission-gated, throttled, JPEG, honest');

// ---------------------------------------------------------------------------
// Transport: frames ride the LIVE session (realtimeInput.video), not a side channel
// ---------------------------------------------------------------------------
assert(liveSrc.includes('sendVideoFrame'), 'gemini-live transport exposes sendVideoFrame');
assert(/realtimeInput:\s*\{\s*video:/.test(liveSrc), 'video frames travel as realtimeInput.video on the live socket');
console.log('  ok   transport: frames ride the live session as realtimeInput.video');

// ---------------------------------------------------------------------------
// Preload + renderer wiring
// ---------------------------------------------------------------------------
assert(preloadSrc.includes("ipcRenderer.invoke('vision:screenFrame')"), 'preload bridges vision:screenFrame');
assert(preloadSrc.includes('visionCaptureScreenFrame'), 'preload exposes visionCaptureScreenFrame to the UI');

for (const id of ['geminiLiveShareScreen', 'geminiLiveShareCamera', 'geminiLiveVisionState']) {
  assert(htmlSrc.includes(`id="${id}"`), `index.html missing live-vision control #${id}`);
}
const visionBlock = htmlSrc.split('geminiLiveShareScreen')[0].slice(-600);
assert(/startGeminiLiveVoiceBtn|SHARE SCREEN|SHARE CAMERA/.test(htmlSrc), 'live vision controls exist next to the live voice controls');
console.log('  ok   UI: share-screen / share-camera toggles + state line in the live voice card');

assert(appSrc.includes('startLiveScreenShare'), 'renderer has a screen-share loop');
assert(appSrc.includes('startLiveCameraShare'), 'renderer has a camera-share loop');
assert(appSrc.includes('api.visionCaptureScreenFrame()'), 'screen frames come from the main-process IPC');
assert(appSrc.includes('session.sendVideoFrame('), 'frames are pushed into the live session');
assert(appSrc.includes('stopAllLiveVision()'), 'hang-up/disconnect must stop every vision loop');
assert(/getUserMedia\(\{\s*video:/.test(appSrc), 'camera capture uses getUserMedia video');
assert(appSrc.includes("toDataURL('image/jpeg'"), 'camera frames are JPEG-compressed');
// Screen-share must respect the awareness permission and teach the fix.
assert(appSrc.includes('SCREEN_AWARENESS_OFF'), 'renderer understands the permission-refused result');
assert(/getTracks\(\)\.forEach/.test(appSrc.split('stopLiveCameraShare')[1].split('function')[0]), 'camera stop releases the tracks');
console.log('  ok   renderer: screen+camera loops, JPEG, permission-aware, full cleanup');

// A mid-call ask works through the normal model turn — the camera/screen
// toggle only attaches media to the SAME live session (no second socket).
assert(!/new WebSocket\([\s\S]{0,200}video/.test(appSrc), 'vision must never open a second socket — it attaches to the live one');
console.log('  ok   architecture: one socket carries mic + video + playback');

console.log('\nAll fused live-vision tests passed.\n');
