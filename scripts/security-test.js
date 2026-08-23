#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function makeResponse() {
  const result = { statusCode: 200, payload: null, headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) {
      result.statusCode = code;
      return { json(payload) { result.payload = payload; return response; }, end() { return response; } };
    },
    json(payload) { result.payload = payload; return response; },
    writeHead(code, headers) { result.statusCode = code; Object.assign(result.headers, headers || {}); },
    write() {},
    end() {}
  };
  return { response, result };
}

async function callChat(body, headers = {}) {
  for (const modulePath of Object.keys(require.cache)) {
    if (modulePath.includes(path.join(ROOT, 'api'))) delete require.cache[modulePath];
  }
  process.env.THROTTLE_PER_MIN = '100';
  const handler = require(path.join(ROOT, 'api/chat.js'));
  const { response, result } = makeResponse();
  await handler({ method: 'POST', headers, body }, response);
  return result;
}

(async () => {
  console.log('\nGemAir security regression tests\n');

  const windowTools = require(path.join(ROOT, 'lib/window-tools.js'));
  let result = await windowTools.launchApp('calculator"; touch owned');
  assert(result.error, 'launchApp must reject shell metacharacters in app names');
  result = await windowTools.launchApp('calculator', 'ok\nmalicious');
  assert(result.error, 'launchApp must reject control characters in arguments');
  result = await windowTools.openSite('https://example.com/";touch-owned', 'not-a-browser;touch');
  assert(result.error, 'openSite must reject unsupported/injected browser names');
  console.log('  ok   desktop launch inputs cannot become shell syntax');

  const modes = require(path.join(ROOT, 'lib/modes.js'));
  assert(modes.saveMode({ name: '../../escape' }).error, 'mode traversal name was accepted');
  assert(modes.saveMode({ name: 'SAFE', apps: ['calc; shutdown'] }).error, 'unsafe app name was accepted');
  assert(modes.saveMode({ name: 'SAFE', sites: [{ url: 'file:///etc/passwd' }] }).error, 'non-http mode URL was accepted');
  console.log('  ok   mode names, apps, and sites are validated');

  const connections = require(path.join(ROOT, 'lib/connections.js'));
  const secureStoreResult = connections.setChatGPTConnection({ accessToken: 'valid-looking-token-that-is-long-enough' });
  assert.strictEqual(secureStoreResult.error, 'ENCRYPTION_UNAVAILABLE', 'credentials should fail closed outside Electron safeStorage');
  console.log('  ok   credential storage fails closed without safeStorage');

  let response = await callChat({ messages: [{ role: 'attacker', content: 'hello' }] }, { 'x-forwarded-for': '198.51.100.30' });
  assert.strictEqual(response.statusCode, 400, 'invalid message role should return 400');
  response = await callChat({ messages: [{ role: 'user', content: 'x'.repeat(10001) }] }, { 'x-forwarded-for': '198.51.100.31' });
  assert.strictEqual(response.statusCode, 400, 'oversized message should return 400');
  response = await callChat({ messages: [{ role: 'user', content: 'hello' }] }, { 'content-length': String(2 * 1024 * 1024), 'x-forwarded-for': '198.51.100.32' });
  assert.strictEqual(response.statusCode, 413, 'oversized declared request should return 413');
  console.log('  ok   chat API rejects malformed and oversized requests');

  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert(main.includes('execFile(parsed.file, parsed.argv'), 'runCommand is not using execFile argv execution');
  assert(main.includes('SAFE_COMMANDS') && main.includes('SAFE_GIT_SUBCOMMANDS'), 'command allow-list is missing');
  assert(main.includes('pathInside(home, target)') && main.includes('fs.realpathSync(probe)'), 'home-bound path and symlink validation is missing');
  assert(main.includes('validateToolInput(name, args)') && main.includes('toolQueueTails'), 'tool validation/rate queue is missing');
  assert(!/exec\(cmd, \{ timeout: 20000 \}/.test(main), 'legacy arbitrary-shell runCommand remains');
  console.log('  ok   shell, path, tool validation, and queue guards are present');

  delete process.env.THROTTLE_PER_MIN;
  console.log('\n  All security regression tests passed.\n');
})().catch((error) => {
  console.error('\n  SECURITY TEST FAILED:', error.stack || error.message || error);
  process.exitCode = 1;
});
