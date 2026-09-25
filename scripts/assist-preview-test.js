#!/usr/bin/env node
"use strict";
/**
 * scripts/assist-preview-test.js
 *
 * Checks the Assist preview harness (`scripts/assist-preview.js`) — and, more
 * usefully, the three-way agreement it depends on:
 *
 *   renderer/iris/**  calls  window.gemair.X
 *   lib/iris/preload.js      maps X onto an ipcRenderer channel
 *   lib/iris/main/index.js   registers a handler for that channel
 *
 * Nothing else in the repo checks that chain end to end. A renderer calling a
 * method the preload does not expose, or a preload channel nobody handles, is a
 * dead button in a window no test can open — exactly the failure that hides in
 * a port. Here it is a failing assertion instead.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const RENDERER_ROOT = path.join(REPO_ROOT, "renderer", "iris");
const PRELOAD_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "lib", "iris", "preload.js"), "utf8");
const PREVIEW_SOURCE = fs.readFileSync(path.join(__dirname, "assist-preview.js"), "utf8");

let passed = 0;
const failures = [];
function check(description, run) {
  try {
    run();
    passed += 1;
    console.log(`  ok   ${description}`);
  } catch (error) {
    failures.push({ description, error });
    console.log(`  FAIL ${description}\n       ${error.message}`);
  }
}
async function checkAsync(description, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ok   ${description}`);
  } catch (error) {
    failures.push({ description, error });
    console.log(`  FAIL ${description}\n       ${error.message}`);
  }
}

/** Every `window.gemair.X(` / `iris.X(` the ported renderers call. */
function bridgeMethodsTheRenderersCall() {
  const methods = new Set();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|html)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/\b(?:window\.)?(?:gemair|iris)\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
        methods.add(match[1]);
      }
    }
  };
  walk(RENDERER_ROOT);
  // `window.__IRIS__.getState()` is the guide panel's own object, not the bridge.
  methods.delete("getState");
  return [...methods].sort();
}

/** The channels `lib/iris/preload.js` actually invokes or listens on. */
function preloadChannels() {
  const channels = new Set();
  for (const match of PRELOAD_SOURCE.matchAll(/ipcRenderer\.(?:invoke|on)\("([^"]+)"/g)) {
    channels.add(match[1]);
  }
  return [...channels].sort();
}

console.log("\nGemAir — Assist preview harness\n");

// MARK: - The renderer / preload / main chain

const rendererMethods = bridgeMethodsTheRenderersCall();

check("every bridge method the renderers call is exposed by lib/iris/preload.js", () => {
  assert.ok(rendererMethods.length > 15, `only found ${rendererMethods.length} bridge calls — the scan broke`);
  const missing = rendererMethods.filter((method) => !new RegExp(`\\b${method}\\s*:`).test(PRELOAD_SOURCE));
  assert.deepEqual(missing, [], `renderers call ${missing.join(", ")}, which preload does not expose`);
});

check("every bridge method the renderers call is in the preview's browser bridge", () => {
  const missing = rendererMethods.filter((method) => !new RegExp(`\\b${method}\\s*:`).test(PREVIEW_SOURCE));
  assert.deepEqual(missing, [], `the preview bridge is missing ${missing.join(", ")}`);
});

check("the preview bridge invokes only channels the preload also uses", () => {
  const known = new Set(preloadChannels());
  const previewBridge = PREVIEW_SOURCE.slice(PREVIEW_SOURCE.indexOf("const BRIDGE_SCRIPT"), PREVIEW_SOURCE.indexOf("const INDEX_PAGE"));
  const used = new Set();
  for (const match of previewBridge.matchAll(/\b(?:invoke|on)\("([^"]+)"/g)) used.add(match[1]);
  const unknown = [...used].filter((channel) => !known.has(channel));
  assert.deepEqual(unknown, [], `preview bridge uses ${unknown.join(", ")}, which the real preload does not`);
});

// MARK: - The live harness

const { createServer, electron, assist } = require("./assist-preview.js");
const server = createServer();

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = async (pathname) => {
    const response = await fetch(base + pathname);
    assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
    return response.text();
  };
  const invoke = async (channel, args = [], windowName = "chat") => {
    const response = await fetch(`${base}/__ipc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, args, window: windowName }),
    });
    return response.json();
  };

  check("every channel the real preload uses has a handler in the mounted main process", () => {
    // `electron.calls.ipcHandlers` is what `setupIPC()` actually registered.
    const handled = new Set(electron.calls.ipcHandlers.keys());
    // The `on(...)` half is main -> renderer, so only the invoke half applies.
    const invoked = [...PRELOAD_SOURCE.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]);
    const unhandled = [...new Set(invoked)].filter((channel) => !handled.has(channel));
    assert.deepEqual(unhandled, [], `preload invokes ${unhandled.join(", ")}, which nothing handles`);
  });

  await checkAsync("the index page lists every Assist window", async () => {
    const html = await text("/");
    for (const name of ["chat", "guide", "autopilot", "settings", "maintain", "first-run", "overlay"]) {
      assert.ok(html.includes(`href="/${name}/"`), `no link to /${name}/`);
    }
  });

  await checkAsync("each window is served from renderer/iris with the bridge injected", async () => {
    for (const name of ["chat", "guide", "settings", "maintain", "autopilot", "first-run", "overlay"]) {
      const html = await text(`/${name}/`);
      // Inlined, because these windows' own CSP allows 'unsafe-inline' scripts
      // but not 'self' — in Electron the bridge arrives through the preload.
      assert.ok(html.includes("window.gemairNative"), `${name} did not get the bridge`);
      const onDiskHtml = fs.readFileSync(path.join(RENDERER_ROOT, name, "index.html"), "utf8");
      if (/Content-Security-Policy/i.test(onDiskHtml)) {
        assert.ok(/connect-src 'self'/.test(html), `${name} kept a CSP the bridge cannot talk through`);
        assert.ok(!/connect-src 'self'/.test(onDiskHtml), `${name}'s own CSP was weakened on disk`);
      }
      assert.ok(html.includes(`data-assist-window="${name}"`), `${name} was not tagged`);
      // Served, not generated: a marker from the real file must survive.
      const marker = onDiskHtml.split("\n").find((line) => line.includes("<title")) ?? "";
      assert.ok(html.includes(marker.trim()), `${name} was not the file on disk`);
    }
  });

  await checkAsync("the bridge is also served as a file, for reading in devtools", async () => {
    assert.ok((await text("/__bridge.js")).includes("window.gemair ="), "no standalone bridge");
  });

  await checkAsync("the guide panel's own assets are served beside it", async () => {
    assert.ok((await text("/guide/app.js")).includes("__TAURI__"), "guide app.js is not the ported panel");
    assert.ok((await text("/guide/styles.css")).length > 1000, "guide styles are missing");
  });

  await checkAsync("a renderer can list the bundled guides over IPC", async () => {
    const result = await invoke("guide:list", [], "guide");
    assert.equal(result.ok, true, result.error);
    assert.ok(result.value.some((guide) => guide.slug === "excalidraw"), "no excalidraw guide");
  });

  await checkAsync("the transplanted panel's own command channel works", async () => {
    const result = await invoke("gemair:invoke", ["fetch_guide", { slug: "excalidraw" }], "guide");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.value.appSlug, "excalidraw");
    const branches = result.value.branches ?? [];
    assert.ok(branches.some((branch) => branch.platform === "windows"), "no windows branch");
    assert.ok(branches.every((branch) => Array.isArray(branch.steps) && branch.steps.length > 0), "a branch has no steps");
  });

  await checkAsync("settings round-trip through the same channels the settings window uses", async () => {
    const before = await invoke("settings:getAll", [], "settings");
    assert.equal(before.ok, true, before.error);
    assert.ok("openCodeModel" in before.value);
    await invoke("settings:set", ["alwaysOnTop", true], "settings");
    const after = await invoke("settings:getAll", [], "settings");
    assert.equal(after.value.alwaysOnTop, true);
    await invoke("settings:set", ["alwaysOnTop", false], "settings");
  });

  await checkAsync("a refused link is refused with a sentence, not a silent no-op", async () => {
    const result = await invoke("shell:openExternal", ["https://publikhq.com/pay"], "guide");
    assert.equal(result.ok, false, "publikhq.com was allowed");
    assert.match(result.error, /GemAir|blocked|allow/i);
  });

  await checkAsync("the chat window gets an answer from the free route", async () => {
    const result = await invoke("chat:query", ["where do i click?"], "chat");
    assert.equal(result.ok, true, result.error);
    assert.ok(String(result.value).length > 0, "empty answer");
    assert.ok(!String(result.value).includes("[POINT:"), "the POINT tag reached the reader");
  });

  await checkAsync("a maintain incident reaches the card over the event stream", async () => {
    const response = await fetch(`${base}/__events?window=maintain`);
    const reader = response.body.getReader();
    const received = [];
    const pump = (async () => {
      const decoder = new TextDecoder();
      while (received.length === 0) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (line.startsWith("data: ")) received.push(JSON.parse(line.slice(6)));
        }
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fetch(`${base}/__demo/crash`, { method: "POST" });
    await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await reader.cancel().catch(() => {});
    const snapshot = received.find((message) => message.channel === "maintain:snapshot");
    assert.ok(snapshot, `no maintain:snapshot pushed (got ${received.map((m) => m.channel).join(", ") || "nothing"})`);
    assert.equal(snapshot.args[0].pendingAsk.appSlug, "excalidraw");
    // Leave no ask behind for the next run of this script.
    await invoke("maintain:answerAsk", ["thatWasMe"], "maintain");
  });

  await checkAsync("an unknown channel fails loudly rather than returning nothing", async () => {
    const response = await fetch(`${base}/__ipc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "nope:notAChannel", args: [], window: "chat" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).ok, false);
  });

  server.close();
  assist.stop();

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
