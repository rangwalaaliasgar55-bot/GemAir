#!/usr/bin/env node
/* ============================================================
   GemAI — zero-dependency local dev server.

   Serves the static renderer/ at "/" and runs every api/*.js
   serverless handler at "/api/<name>", mimicking Vercel's Node
   runtime (req.query / req.body / res.json / res.status).

   Usage:  npm run serve       (then open http://localhost:3000)
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'renderer');
const API_DIR = path.join(ROOT, 'api');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Load .env (if present) so GROQ_API_KEY / SUPABASE_* work locally.
(function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

/** Wrap a raw Node response in the Vercel-style helpers the handlers expect. */
function decorate(req, res, query) {
  req.query = query;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (typeof body === 'object') return res.json(body);
    res.end(String(body));
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleApi(req, res, url) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  const file = path.join(API_DIR, name + '.js');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (!name || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'No such API route: /api/' + name }));
  }

  const query = Object.fromEntries(url.searchParams.entries());
  decorate(req, res, query);
  if (req.method === 'POST') req.body = await readBody(req);

  try {
    delete require.cache[require.resolve(file)]; // hot-reload on every request
    const handler = require(file);
    await handler(req, res);
    if (!res.writableEnded) res.end();
  } catch (e) {
    console.error(`[api/${name}]`, e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    if (!res.writableEnded) res.end(JSON.stringify({ error: e.message }));
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // mirror the Vercel rewrite: "/foo" -> "renderer/foo"
  const file = path.join(STATIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!file.startsWith(STATIC_DIR)) { res.statusCode = 403; return res.end('Forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404 — not found: ' + rel);
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  GemAI dev server running`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → static: renderer/   api: api/*.js\n`);
});
