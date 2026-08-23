#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');

console.log('\nGemAir Electron-boundary regression tests\n');

const start = main.indexOf('function trustedExternalUrl');
const end = main.indexOf('function configureAuthWindowSecurity', start);
assert(start >= 0 && end > start, 'browser-boundary validators are missing');
const context = { URL, String, decodeURIComponent };
vm.runInNewContext(`${main.slice(start, end)}\nthis.api = { trustedExternalUrl, isAppFileUrl, isLocalFileOrigin, authHostAllowed };`, context);
const api = context.api;
assert(api.trustedExternalUrl('https://example.com/path'));
assert.strictEqual(api.trustedExternalUrl('https://user:password@example.com'), null);
assert.strictEqual(api.trustedExternalUrl('javascript:alert(1)'), null);
assert.strictEqual(api.trustedExternalUrl('file:///etc/passwd'), null);
assert.strictEqual(api.isAppFileUrl('file:///opt/gemair/renderer/index.html'), true);
assert.strictEqual(api.isAppFileUrl('file:///etc/passwd'), false);
assert.strictEqual(api.isLocalFileOrigin('file://'), true);
assert.strictEqual(api.authHostAllowed('https://auth.openai.com/login', 'chatgpt'), true);
assert.strictEqual(api.authHostAllowed('https://accounts.google.com/signin', 'gemini'), true);
assert.strictEqual(api.authHostAllowed('https://openai.com.evil.example/login', 'chatgpt'), false);
assert.strictEqual(api.authHostAllowed('http://chatgpt.com/login', 'chatgpt'), false);
console.log('  ok   app, external, and authentication URLs are strictly classified');

assert(main.includes('sandbox: true'), 'Electron renderer sandbox is not enabled');
assert(!main.includes('sandbox: false'), 'an unsandboxed BrowserWindow remains');
assert(main.includes('allowRunningInsecureContent: false'), 'insecure mixed content is not explicitly disabled');
assert(main.includes('webviewTag: false'), 'webview embedding is not explicitly disabled');
assert(main.includes('navigateOnDragDrop: false'), 'drag-and-drop navigation is not disabled');
assert(main.includes('safeDialogs: true'), 'dialog loop protection is not enabled');
assert(main.includes("mainWindow.webContents.on('will-navigate'"), 'main-window navigation guard is missing');
assert(main.includes("window.webContents.on('did-create-window'"), 'authentication popup hardening is missing');
assert(!main.includes("url.startsWith('http')"), 'prefix-only external URL validation remains');
console.log('  ok   all Electron windows are sandboxed and navigation guarded');

assert(main.includes('mainSession.setPermissionRequestHandler'), 'permission request handler is missing');
assert(main.includes('mainSession.setPermissionCheckHandler'), 'permission check handler is missing');
assert(main.includes("permission === 'media'"), 'microphone permission is not explicitly scoped');
assert(main.includes('webContents === mainWindow.webContents'), 'permissions are not restricted to the main renderer');
assert(main.includes('isLocalFileOrigin(requestingOrigin || mainWindow.webContents.getURL())'), 'permissions are not restricted to the local app origin');
console.log('  ok   Electron permissions use a media-only local-app policy');

const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
assert(csp.includes("object-src 'none'"), 'CSP does not block plugins');
assert(csp.includes("base-uri 'none'"), 'CSP does not block base-tag rewriting');
assert(csp.includes("form-action 'none'"), 'CSP does not block form exfiltration');
assert(!/script-src[^;]*'unsafe-inline'/.test(csp), 'CSP still allows inline scripts');
assert(html.includes('@supabase/supabase-js@2.45.0'), 'Supabase CDN dependency is not version pinned');
assert(renderer.includes("securityLevel: 'strict'"), 'Mermaid rendering is not using strict sanitization');
assert(!renderer.includes("securityLevel: 'loose'"), 'loose Mermaid SVG rendering remains');
console.log('  ok   CSP and third-party script rendering are tightened');

console.log('\n  All Electron-boundary regression tests passed.\n');
