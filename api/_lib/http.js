// ============================================================
// GemAir — shared serverless guard (api/_lib/http.js)
//
// One source of truth for every api/*.js function:
//   • VERSION          — must match package.json (selfcheck enforces it)
//   • originAllowed()  — the R10 origin/referer allow-list
//   • applyCors()      — PRECISE CORS (echoes the caller's origin when it is
//                        allowed; sets nothing for native/curl callers).
//                        The vercel.json wildcard ACAO was removed — do not
//                        reintroduce it: it let any website burn the shared
//                        free-tier keys from a browser.
//   • guard()          — OPTIONS short-circuit + origin gate + CORS, in one call
//   • fetchJson()/fetchText() — every upstream call gets an AbortController
//                        deadline so a hung provider cannot pin the function.
// Zero dependencies by design — plain fetch only.
// ============================================================
'use strict';

const VERSION = '2.5.2';

function env(key) {
  try { return String(process.env[key] || '').trim(); } catch { return ''; }
}

/**
 * Hosts allowed to call GemAir's free APIs. Defaults cover the app's own
 * origins; ALLOWED_ORIGINS (comma-separated hostnames) extends the list.
 */
function allowedHosts() {
  const extra = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [
    'gemair.vercel.app',
    'localhost', '127.0.0.1', '0.0.0.0',
    ...extra
  ];
}

/** Same policy as api/chat.js uses for the chat proxy. */
function originAllowed(req) {
  const raw = (req.headers && (req.headers.origin || req.headers.referer)) || '';
  if (!raw) return { ok: true, origin: '' };           // desktop app / curl / monitors
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return { ok: false, origin: raw }; }
  const list = allowedHosts();
  const ok = list.some((h) => host === h || host.endsWith('.' + h)) ||
    /\.vercel\.app$/.test(host) ||                     // preview deployments
    host.endsWith('.e2b.app');                         // sandboxed dev preview
  return { ok, origin: host };
}

/** The caller's full origin (scheme + host) or ''. */
function requestOrigin(req) {
  const o = req.headers && req.headers.origin;
  if (o) return String(o);
  const ref = req.headers && req.headers.referer;
  if (ref) { try { return new URL(ref).origin; } catch { return ''; } }
  return '';
}

/**
 * Precise CORS: echo the exact requesting origin when it is on the allow-list,
 * set no ACAO header otherwise (same-origin requests need none anyway).
 */
function applyCors(req, res) {
  const origin = requestOrigin(req);
  if (origin && originAllowed({ headers: { origin } }).ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

/** JSON helper with no-store default (opt out with cacheable=true). */
function json(res, status, obj, cacheable) {
  res.statusCode = status;
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheable ? 'public, max-age=300' : 'no-store');
  res.end(JSON.stringify(obj));
}

/**
 * Standard entry guard for every function:
 *   returns true when the request is fully handled (OPTIONS preflight or a
 *   rejected origin) and the handler must stop; false when it may proceed.
 */
function guard(req, res) {
  if (req.method === 'OPTIONS') { applyCors(req, res); res.statusCode = 204; res.end(); return true; }
  const origin = originAllowed(req);
  if (!origin.ok) { json(res, 403, { ok: false, error: 'origin_not_allowed', origin: origin.origin }); return true; }
  applyCors(req, res);
  return false;
}

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchWithDeadline(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      const err = new Error('upstream timeout after ' + timeoutMs + 'ms');
      err.isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const r = await fetchWithDeadline(url, opts, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!r.ok) throw new Error('HTTP_' + r.status);
  return r.json();
}

async function fetchText(url, opts = {}) {
  const r = await fetchWithDeadline(url, opts, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!r.ok) throw new Error('HTTP_' + r.status);
  return r.text();
}

module.exports = { VERSION, env, allowedHosts, originAllowed, requestOrigin, applyCors, json, guard, fetchJson, fetchText, fetchWithDeadline };
