#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

console.log('\nGemAir network-boundary regression tests\n');

let start = main.indexOf('function isPrivateNetworkAddress');
let end = main.indexOf('async function requirePublicHttpUrl', start);
assert(start >= 0 && end > start, 'private-network validator is missing');
let context = { net, String };
vm.runInNewContext(`${main.slice(start, end)}\nthis.isPrivate = isPrivateNetworkAddress;`, context);
for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.2', '169.254.1.1', '100.64.1.1', '198.51.100.1', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
  assert.strictEqual(context.isPrivate(address), true, `${address} must be blocked`);
}
for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.strictEqual(context.isPrivate(address), false, `${address} should be public`);
console.log('  ok   local, private, link-local, and reserved IP ranges are blocked');

start = main.indexOf('const MAX_WEBPAGE_BYTES');
end = main.indexOf('async function fetchWebpage', start);
assert(start >= 0 && end > start, 'bounded response reader is missing');
context = { TextDecoder, Uint8Array, Number, Error };
vm.runInNewContext(`${main.slice(start, end)}\nthis.readLimited = readResponseTextLimited;`, context);
function responseFrom(chunks, declared = null) {
  let index = 0, cancelled = false;
  return {
    headers: { get(name) { return name === 'content-length' ? declared : null; } },
    body: {
      getReader() { return { async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; }, async cancel() { cancelled = true; } }; },
      async cancel() { cancelled = true; }
    },
    wasCancelled() { return cancelled; }
  };
}

(async () => {
  const encoder = new TextEncoder();
  let response = responseFrom([encoder.encode('hello '), encoder.encode('world')], '11');
  assert.strictEqual(await context.readLimited(response, 32), 'hello world');
  response = responseFrom([new Uint8Array(8), new Uint8Array(8)], null);
  await assert.rejects(() => context.readLimited(response, 10), /WEBPAGE_TOO_LARGE/);
  assert.strictEqual(response.wasCancelled(), true, 'oversized response stream was not cancelled');
  response = responseFrom([], '100');
  await assert.rejects(() => context.readLimited(response, 10), /WEBPAGE_TOO_LARGE/);
  assert.strictEqual(response.wasCancelled(), true, 'declared oversized response was not cancelled');
  console.log('  ok   webpage bodies are streamed, size-limited, and cancelled on overflow');

  assert(main.includes("fetchPublicWithRedirects(url"), 'webpage fetch does not use the public-network redirect guard');
  assert(main.includes("redirect: 'manual'"), 'redirects are not handled manually');
  assert(main.includes('requirePublicHttpUrl(current, { httpsOnly, signal: options && options.signal })'), 'each redirect target is not DNS-validated');
  assert(main.includes("setTimeout(() => controller.abort(), 12000)"), 'webpage deadline is missing');
  assert(main.includes("MAX_WEBPAGE_BYTES = 2 * 1024 * 1024"), 'webpage size limit is missing');
  assert(main.includes("return { error: 'Unsupported webpage content type.' }"), 'binary webpage content is not rejected');
  assert(main.includes("signal.addEventListener('abort', abortHandler, { once: true })"), 'DNS resolution is not abort-aware');
  console.log('  ok   redirects, DNS, content type, and total request time are guarded');

  console.log('\n  All network-boundary regression tests passed.\n');
})().catch((error) => {
  console.error('\n  NETWORK BOUNDARY TEST FAILED:', error.stack || error);
  process.exitCode = 1;
});
