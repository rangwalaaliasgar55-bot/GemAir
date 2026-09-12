#!/usr/bin/env node
'use strict';

/*
 * GemAir FreeGPT35 compatibility sidecar.
 *
 * Derived from missuo/FreeGPT35 at revision
 * 3bf421eecee954a5361677ec225f61348684f6bc.
 * Copyright (C) FreeGPT35 contributors and GemAir contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3. See ./LICENSE.
 *
 * Changes from upstream are documented in README.md. Most importantly this
 * sidecar never disables TLS verification, binds only to loopback, requires a
 * per-process bearer secret, validates request sizes, and reports upstream
 * errors truthfully.
 */

const http = require('http');
const { createHash, randomInt, randomUUID, timingSafeEqual } = require('crypto');

// Keep the pinned upstream connection host and protocol shape verbatim. Fetch
// follows OpenAI's redirect if the service moves the anonymous endpoint.
const DEFAULT_BASE_URL = 'https://chat.openai.com';
const MODEL = 'gpt-3.5-turbo';
const UPSTREAM_MODEL = 'text-davinci-002-render-sha';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGES = 96;
const MAX_MESSAGE_CHARS = 128 * 1024;
const REQUEST_TIMEOUT_MS = Math.max(50, Math.min(120_000, Number(process.env.FREEGPT35_REQUEST_TIMEOUT_MS) || 45_000));
const MAX_CONCURRENT = 2;
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const AUTH_TOKEN = String(process.env.GEMAIR_SIDECAR_TOKEN || '');
const BASE_URL = normalizeBaseUrl(process.env.FREEGPT35_BASE_URL || DEFAULT_BASE_URL);
let activeRequests = 0;

function normalizeBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BASE_URL));
  if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) {
    throw new Error('FREEGPT35_BASE_URL must use HTTPS. HTTP is accepted only for loopback tests.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function completionId(prefix = 'chatcmpl-') {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = prefix;
  for (let index = 0; index < 28; index++) value += chars[randomInt(0, chars.length)];
  return value;
}

// FreeGPT35's proof-of-work implementation, with bounded and validated inputs.
function generateProofToken(seed, difficulty, userAgent = USER_AGENT) {
  const cleanSeed = String(seed || '').slice(0, 512);
  const cleanDifficulty = String(difficulty || '').toLowerCase();
  if (!cleanSeed || !/^[0-9a-f]{1,128}$/.test(cleanDifficulty) || cleanDifficulty.length % 2 !== 0) {
    throw new Error('FREEGPT35_INVALID_PROOF_CHALLENGE');
  }
  const cores = [8, 12, 16, 24];
  const screens = [3000, 4000, 6000];
  const core = cores[randomInt(0, cores.length)];
  const screen = screens[randomInt(0, screens.length)];
  const now = new Date(Date.now() - 8 * 3600 * 1000);
  const parseTime = now.toUTCString().replace('GMT', 'GMT-0500 (Eastern Time)');
  const config = [core + screen, parseTime, 4294705152, 0, String(userAgent).slice(0, 512)];
  const prefixLength = cleanDifficulty.length / 2;
  for (let index = 0; index < 100000; index++) {
    config[3] = index;
    const base = Buffer.from(JSON.stringify(config)).toString('base64');
    const hash = createHash('sha3-512').update(cleanSeed + base).digest('hex');
    if (hash.substring(0, prefixLength) <= cleanDifficulty) return 'gAAAAAB' + base;
  }
  return 'gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(JSON.stringify(cleanSeed)).toString('base64');
}

function browserHeaders(extra = {}) {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'content-type': 'application/json',
    'oai-language': 'en-US',
    origin: BASE_URL,
    pragma: 'no-cache',
    referer: BASE_URL + '/',
    'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': USER_AGENT,
    ...extra
  };
}

async function strictFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('FREEGPT35_UPSTREAM_TIMEOUT')), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getNewSession(retries = Number(process.env.NEW_SESSION_RETRIES) || 5) {
  let lastError = null;
  for (let attempt = 0; attempt <= Math.max(0, Math.min(5, retries)); attempt++) {
    const deviceId = randomUUID();
    try {
      const response = await strictFetch(`${BASE_URL}/backend-anon/sentinel/chat-requirements`, {
        method: 'POST',
        headers: browserHeaders({ 'oai-device-id': deviceId }),
        body: '{}'
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`FREEGPT35_SESSION_HTTP_${response.status}: ${text.slice(0, 300)}`);
      const session = JSON.parse(text);
      if (!session || typeof session.token !== 'string' || !session.proofofwork) throw new Error('FREEGPT35_INVALID_SESSION');
      return { ...session, deviceId };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await wait(Math.min(2000, 300 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('FREEGPT35_SESSION_UNAVAILABLE');
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) throw new Error('messages must be a non-empty array of at most 96 items');
  return value.map((message) => {
    const role = String(message && message.role || '');
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw new Error(`unsupported message role: ${role || '(empty)'}`);
    if (typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS) throw new Error('each message must have bounded text content');
    return { role: role === 'developer' ? 'system' : role, content: message.content };
  });
}

function conversationBody(messages) {
  return {
    action: 'next',
    messages: messages.map((message) => ({
      author: { role: message.role },
      content: { content_type: 'text', parts: [message.content] }
    })),
    parent_message_id: randomUUID(),
    model: UPSTREAM_MODEL,
    timezone_offset_min: -180,
    suggestions: [],
    history_and_training_disabled: true,
    conversation_mode: { kind: 'primary_assistant' },
    websocket_request_id: randomUUID()
  };
}

async function* sseData(stream) {
  if (!stream || typeof stream.getReader !== 'function') throw new Error('FREEGPT35_EMPTY_STREAM');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
      buffer = buffer.slice(boundary + separator.length);
      const payload = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (payload && payload !== '[DONE]') yield payload;
    }
  }
  buffer += decoder.decode();
  const payload = buffer.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (payload && payload !== '[DONE]') yield payload;
}

function assistantSnapshot(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { return null; }
  if (parsed && parsed.error) throw new Error(`FREEGPT35_UPSTREAM_ERROR: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error).slice(0, 300)}`);
  const message = parsed && parsed.message;
  const content = message && message.content && Array.isArray(message.content.parts) ? message.content.parts[0] : '';
  if (typeof content !== 'string') return null;
  const status = String(message.status || '');
  const detail = message.metadata && message.metadata.finish_details && message.metadata.finish_details.type;
  return { content, done: status === 'finished_successfully', finishReason: detail === 'max_tokens' ? 'length' : (status === 'finished_successfully' ? 'stop' : null) };
}

function writeJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function authorized(request) {
  if (!AUTH_TOKEN) return false;
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(AUTH_TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 }); }
}

async function chatCompletion(request, response) {
  if (activeRequests >= MAX_CONCURRENT) return writeJson(response, 429, { error: { message: 'FreeGPT35 sidecar is busy. Retry shortly.', type: 'rate_limit_error' } });
  activeRequests++;
  try {
    const input = await readJson(request);
    const messages = validateMessages(input.messages);
    const session = await getNewSession();
    const proof = generateProofToken(session.proofofwork.seed, session.proofofwork.difficulty, USER_AGENT);
    const upstream = await strictFetch(`${BASE_URL}/backend-api/conversation`, {
      method: 'POST',
      headers: browserHeaders({
        'oai-device-id': session.deviceId,
        'openai-sentinel-chat-requirements-token': session.token,
        'openai-sentinel-proof-token': proof
      }),
      body: JSON.stringify(conversationBody(messages))
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw Object.assign(new Error(`FREEGPT35_CHAT_HTTP_${upstream.status}: ${detail.slice(0, 300)}`), { upstreamStatus: upstream.status });
    }

    const id = completionId();
    const created = Math.floor(Date.now() / 1000);
    let fullContent = '';
    let finishReason = null;
    const stream = input.stream === true;
    if (stream) response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });

    for await (const payload of sseData(upstream.body)) {
      const snapshot = assistantSnapshot(payload);
      if (!snapshot) continue;
      // Upstream emits cumulative text. Do not echo an input message or regress.
      if (messages.some((message) => message.content === snapshot.content)) continue;
      const extendsPrevious = snapshot.content.startsWith(fullContent);
      // A cumulative stream can repeat or briefly regress. Only forward text
      // that extends the longest accepted snapshot; clients cannot retract.
      const delta = extendsPrevious ? snapshot.content.slice(fullContent.length) : '';
      if (extendsPrevious) fullContent = snapshot.content;
      finishReason = snapshot.finishReason || finishReason;
      if (stream && delta) response.write(`data: ${JSON.stringify({ id, created, object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
    }
    if (!fullContent.trim()) throw new Error('FREEGPT35_EMPTY_RESPONSE');

    if (stream) {
      response.write(`data: ${JSON.stringify({ id, created, object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      writeJson(response, 200, {
        id, created, model: MODEL, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: finishReason || 'stop' }],
        usage: {
          prompt_tokens: Math.ceil(messages.reduce((sum, message) => sum + message.content.length, 0) / 4),
          completion_tokens: Math.ceil(fullContent.length / 4),
          total_tokens: Math.ceil((messages.reduce((sum, message) => sum + message.content.length, 0) + fullContent.length) / 4)
        }
      });
    }
  } catch (error) {
    if (!response.headersSent) {
      const status = error.statusCode || (error.upstreamStatus === 429 ? 429 : 502);
      writeJson(response, status, { error: { message: error.message || String(error), type: status === 429 ? 'rate_limit_error' : 'upstream_error' } });
    } else {
      response.write(`data: ${JSON.stringify({ error: { message: error.message || String(error), type: 'upstream_error' } })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  } finally {
    activeRequests--;
  }
}

function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    if (!authorized(request)) return writeJson(response, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } });
    if (request.method === 'GET' && request.url === '/health') return writeJson(response, 200, { ok: true, provider: 'freegpt35', model: MODEL, upstream: BASE_URL, tlsVerification: true });
    if (request.method === 'GET' && request.url === '/source') return writeJson(response, 200, { source: 'https://github.com/missuo/FreeGPT35', revision: '3bf421eecee954a5361677ec225f61348684f6bc', license: 'AGPL-3.0-only' });
    if (request.method === 'GET' && request.url === '/v1/models') return writeJson(response, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'freegpt35' }] });
    if (request.method === 'POST' && request.url === '/v1/chat/completions') return chatCompletion(request, response);
    return writeJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
  });
}

if (require.main === module) {
  if (!AUTH_TOKEN) {
    console.error('GEMAIR_SIDECAR_TOKEN is required.');
    process.exit(2);
  }
  const server = createServer();
  server.listen(Number(process.env.SERVER_PORT) || 0, '127.0.0.1', () => {
    const address = server.address();
    if (process.send) process.send({ type: 'ready', port: address.port, provider: 'freegpt35' });
    else console.log(JSON.stringify({ type: 'ready', port: address.port, provider: 'freegpt35' }));
  });
  const close = () => server.close(() => process.exit(0));
  process.on('message', (message) => { if (message && message.type === 'shutdown') close(); });
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
}

module.exports = { assistantSnapshot, completionId, conversationBody, createServer, generateProofToken, normalizeBaseUrl, sseData, validateMessages };
