/* Gem Air Browser Link — service worker.

   Responsibilities (all real, none simulated):
   1. Report the ACTIVE TAB's url/title to the desktop app (so the island can say
      "YouTube · Distraction" instead of "Chrome is open").
   2. Pull the current block policy from the app and actually stop navigation to
      blocked sites by replacing the tab with the local block page.
   3. Report blocked attempts back so they are recorded.

   The app runs a loopback-only server on 127.0.0.1; the token is obtained once
   via a pairing code the user reads from the desktop UI. */

const PORT = 8677;
const BASE = `http://127.0.0.1:${PORT}`;
const POLICY_REFRESH_MS = 15000;

let policy = { blocked: [], exceptions: [], categoryRules: [] };
let token = null;

async function loadToken() {
  if (token) return token;
  const { gemairToken } = await chrome.storage.local.get('gemairToken');
  token = gemairToken || null;
  return token;
}

async function call(path, options = {}) {
  const t = await loadToken();
  if (!t) throw new Error('not paired');
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-gemair-token': t, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}

async function pair(code) {
  const res = await fetch(`${BASE}/pair?code=${encodeURIComponent(code)}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'pairing failed');
  token = data.token;
  await chrome.storage.local.set({ gemairToken: token });
  await refreshPolicy();
  return true;
}

async function refreshPolicy() {
  try {
    const data = await call('/policy');
    policy = { blocked: data.blocked || [], exceptions: data.exceptions || [], categoryRules: data.categoryRules || [] };
    await chrome.storage.local.set({ gemairPolicyAt: Date.now() });
  } catch (e) { /* app closed — fail open, never break browsing */ }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function hostMatches(host, pattern) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  const p = String(pattern || '').toLowerCase().replace(/^www\./, '');
  return !!h && !!p && (h === p || h.endsWith('.' + p));
}

function decide(url) {
  const host = hostOf(url);
  if (!host) return null;
  const rule = policy.blocked.find((b) => hostMatches(host, b.target));
  if (!rule) return null;
  const now = Date.now();
  const ex = policy.exceptions.find((e) => hostMatches(host, e.target) && (!e.until || e.until > now));
  if (ex && (!rule.protected || ex.overridesProtected)) return null;
  return rule;
}

function blockPageUrl(host, reason, isProtected) {
  return chrome.runtime.getURL('blocked.html')
    + `?site=${encodeURIComponent(host)}&reason=${encodeURIComponent(reason || '')}&protected=${isProtected ? 1 : 0}`;
}

async function enforce(tabId, url) {
  const rule = decide(url);
  if (!rule) return false;
  const host = hostOf(url);
  try { await chrome.tabs.update(tabId, { url: blockPageUrl(host, rule.reason, rule.protected) }); } catch {}
  try { await call('/attempt', { method: 'POST', body: JSON.stringify({ subject: host, label: host, reason: rule.reason, at: Date.now() }) }); } catch {}
  return true;
}

async function reportActive(tab) {
  if (!tab || !tab.url || tab.url.startsWith('chrome')) return;
  try {
    await call('/tab', { method: 'POST', body: JSON.stringify({ url: tab.url, title: tab.title || '', browser: 'chrome', at: Date.now() }) });
  } catch {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (await enforce(tabId, tab.url)) return;
  reportActive(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.active) return;
  if (info.url || info.status === 'loading') {
    if (await enforce(tabId, tab.url)) return;
  }
  if (info.status === 'complete' || info.title || info.url) reportActive(tab);
});

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await enforce(details.tabId, details.url);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) reportActive(tab);
});

// Heartbeat: the service worker is suspended after ~30s idle, which used to
// stop tab reports — the app then "forgot" the current website. Two fixes:
//   - every alarm tick ALSO re-reports the active tab, so context stays fresh
//     even with zero navigation events (user just reading one long page);
//   - the worker re-reports on every cold start (bottom of this file), so a
//     suspension can never end in a silent, stale site.
async function reportActiveFromQuery() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) reportActive(tab);
  } catch {}
}

chrome.alarms.create('gemair-policy', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'gemair-policy') { refreshPolicy(); reportActiveFromQuery(); }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'pair') {
      try { await pair(msg.code); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    } else if (msg.type === 'status') {
      const t = await loadToken();
      const { gemairPolicyAt } = await chrome.storage.local.get('gemairPolicyAt');
      sendResponse({ paired: !!t, blockedCount: policy.blocked.length, lastSync: gemairPolicyAt || null });
    } else if (msg.type === 'unpair') {
      token = null;
      await chrome.storage.local.remove('gemairToken');
      sendResponse({ ok: true });
    }
  })();
  return true;
});

refreshPolicy();
setInterval(refreshPolicy, POLICY_REFRESH_MS);
// Cold start (worker revival, browser launch): restore policy + report the
// current tab immediately instead of waiting for the user to navigate.
reportActiveFromQuery();
