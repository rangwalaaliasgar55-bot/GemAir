#!/usr/bin/env node
/* GemAir Assist — the ported Iris subsystem. Pure logic, no Electron, no network.
 *
 * What this file is for: the port changed three things everywhere — the model
 * routes are OpenCode's free ones, there is no publik, and the guides ship
 * inside the app. Each of those is an invariant a later edit can quietly break
 * in a way no crash reports, so each is asserted here rather than trusted.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const IRIS = path.join(ROOT, 'lib', 'iris');

const models = require(path.join(IRIS, 'services/opencode-models'));
const transport = require(path.join(IRIS, 'services/assistant-transport'));
const guideService = require(path.join(IRIS, 'services/guide-service'));
const guideModel = require(path.join(IRIS, 'services/autopilot/guide-model'));
const recipes = require(path.join(IRIS, 'services/autopilot/recipes'));
const { guideBackedRecipeResolver } = require(path.join(IRIS, 'services/autopilot/guide-recipe-resolver'));
const externalLinks = require(path.join(IRIS, 'services/external-links'));
const toolVersions = require(path.join(IRIS, 'services/tool-versions'));
const deepLinks = require(path.join(IRIS, 'services/deep-link-parser'));
const coordinates = require(path.join(IRIS, 'services/coordinates'));
const appInventory = require(path.join(IRIS, 'services/maintain/app-inventory'));
const poolClient = require(path.join(IRIS, 'services/maintain/pool-client'));
const integration = require(path.join(IRIS, 'integration'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

async function main() {
  console.log('\nfree models only');
  test('the default model is a free one', () => {
    assert.ok(models.isFreeModelId(models.DEFAULT_FREE_MODEL));
    assert.ok(models.knownFreeModelIds().includes(models.DEFAULT_FREE_MODEL));
  });
  test('a paid model id is refused, by name, before any request exists', () => {
    assert.throws(() => models.assertFreeModelId('claude-opus-4-1-20250805'), models.FreeModelRefusal);
    assert.throws(() => models.assertFreeModelId('gpt-4o'), models.FreeModelRefusal);
  });
  test('the refusal names the model and offers a free one', () => {
    try {
      models.assertFreeModelId('gpt-4o');
      assert.fail('expected a refusal');
    } catch (error) {
      assert.match(error.message, /gpt-4o/);
      assert.match(error.message, new RegExp(models.DEFAULT_FREE_MODEL));
    }
  });
  test('a stale settings value naming a paid model never becomes a paid request', () => {
    const chosen = transport.defaultModelForTransport({ tier: 'zen' }, 'claude-opus-4-1-20250805');
    assert.ok(models.isFreeModelId(chosen), `${chosen} must be free`);
  });
  test('the catalogue refresh only ever learns ids the catalogue marks free', () => {
    const before = models.knownFreeModelIds().length;
    models.refreshFreeModelIds(JSON.stringify({
      data: [
        { id: 'totally-paid-model', cost: { input: 3, output: 15 } },
        { id: 'brand-new-free', cost: { input: 0, output: 0 } },
      ],
    }));
    assert.ok(models.knownFreeModelIds().includes('brand-new-free'));
    assert.ok(!models.knownFreeModelIds().includes('totally-paid-model'));
    assert.ok(models.knownFreeModelIds().length >= before);
  });
  test('the default model is one the picker actually offers', () => {
    assert.ok(models.chatCapableFreeModelIds().includes(models.DEFAULT_FREE_MODEL));
    // The screenshot pipeline sends images, so the vision default must be free too.
    assert.ok(models.isFreeModelId(models.DEFAULT_FREE_VISION_MODEL));
  });
  test('a free id that is not a chat model is never offered as one', () => {
    for (const id of models.NON_CHAT_FREE_MODEL_IDS) {
      // Free — the gate is about money, and these cost nothing...
      assert.ok(models.isFreeModelId(id), `${id} should still pass the free gate`);
      // ...but they answer on /systemone or /responses, so chat must not offer them.
      assert.ok(!models.chatCapableFreeModelIds().includes(id), `${id} must not be offered`);
    }
  });
  test("the live catalogue's id-only shape still teaches the gate correctly", () => {
    // OpenCode's real GET /models returns ids with no prices, so the `-free`
    // suffix is the only signal available. Anything without it stays paid.
    models.refreshFreeModelIds(JSON.stringify({
      object: 'list',
      data: [{ id: 'claude-opus-5' }, { id: 'promo-model-free' }, { id: 'gpt-6-astra' }],
    }));
    assert.ok(models.isFreeModelId('promo-model-free'));
    assert.ok(!models.isFreeModelId('claude-opus-5'));
    assert.ok(!models.isFreeModelId('gpt-6-astra'));
  });
  test('there is no top-up, because there is nothing to buy', () => {
    assert.strictEqual(transport.shouldOfferTopUp(), false);
  });

  console.log('\nroute selection');
  test('with nothing configured at all, the free hosted route answers', () => {
    const selected = transport.selectTransport({});
    assert.strictEqual(selected.tier, 'zen');
    assert.strictEqual(transport.requiresSetup(selected), false);
  });
  test('a pinned CLI route that is absent refuses rather than silently switching', () => {
    assert.throws(
      () => transport.selectTransport({ preference: 'opencodeCli', cliIsAvailable: false }),
      (error) => {
        assert.strictEqual(error.detail.kind, 'chosenProviderUnavailable');
        assert.ok(transport.requiresSetup(error.detail), 'a pinned, absent route must ask for setup');
        assert.match(error.message, /won't quietly switch/i);
        return true;
      }
    );
  });
  test('a local opencode server wins over the hosted route when one is running', () => {
    const selected = transport.selectTransport({ localServerBaseUrl: 'http://127.0.0.1:4096/v1' });
    assert.strictEqual(selected.tier, 'server');
  });
  test("the reader's own key is used when they have one", () => {
    const selected = transport.selectTransport({ storedOpenCodeApiKey: 'sk-reader-key' });
    assert.strictEqual(selected.tier, 'zen');
    assert.strictEqual(selected.apiKey, 'sk-reader-key');
  });
  test('a credential never leaves opencode.ai', () => {
    assert.ok(transport.credentialMayReachHost('openCodeApiKey', 'opencode.ai'));
    assert.ok(!transport.credentialMayReachHost('openCodeApiKey', 'example.com'));
    assert.ok(!transport.credentialMayReachHost('openCodeApiKey', 'api.anthropic.com'));
    // An unknown credential kind reaches nothing, rather than everything.
    assert.ok(!transport.credentialMayReachHost('someOtherKey', 'opencode.ai'));
  });
  await testAsync('a chat request goes to opencode.ai with a bearer token', async () => {
    const request = await transport.makeChatRequest(transport.selectTransport({}));
    assert.match(request.url, /^https:\/\/opencode\.ai\//);
    assert.ok(String(request.headers.Authorization || '').startsWith('Bearer '));
    // Every HTTP route picks its own model, so the field is always sent.
    assert.ok(transport.shouldSendModelInRequestBody({ tier: 'zen' }));
  });
  await testAsync('the CLI route makes no HTTP request at all', async () => {
    await assert.rejects(() => transport.makeChatRequest({ tier: 'cli' }));
  });

  console.log('\nno publik anywhere in the shipped surface');
  test('no source file under lib/iris mentions publik outside a comment', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|json)$/.test(entry.name)) continue;
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (!/publik/i.test(line)) return;
          const trimmed = line.trim();
          // A comment may discuss what upstream did; code may not do it.
          if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
          // The one legitimate code use: scrubbing an old install's stored key.
          if (/LEGACY|legacy/.test(lines.slice(Math.max(0, index - 12), index).join('\n'))) return;
          // A self-hoster may still pass their own base URL in.
          if (/publikBaseUrl/.test(line)) return;
          offenders.push(`${path.relative(ROOT, full)}:${index + 1}`);
        });
      }
    };
    walk(IRIS);
    assert.deepStrictEqual(offenders, [], `publik in shipped code: ${offenders.join(', ')}`);
  });
  test('the renderer never calls a publik or account bridge method', () => {
    const rendererDir = path.join(ROOT, 'renderer', 'iris');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        const text = fs.readFileSync(full, 'utf8');
        for (const banned of ['provisionPublikApi', 'publikBalance', 'signIn(', 'markPublikCardShown', 'refreshCodexAvailability']) {
          if (text.includes(banned)) offenders.push(`${path.relative(ROOT, full)} → ${banned}`);
        }
      }
    };
    walk(rendererDir);
    assert.deepStrictEqual(offenders, []);
  });
  await testAsync('the maintain pool is off by default, so nothing phones home', async () => {
    assert.strictEqual(poolClient.DEFAULT_MAINTAIN_POOL_BASE_URL, '');
    const client = new poolClient.MaintainPoolClient({});
    const result = await client.lookupRecipes({ appSlug: 'ollama', signatureId: 'x' });
    assert.deepStrictEqual(result, { recipes: [], matchedBy: null });
  });
  await testAsync('the app catalogue is local and never fetched by default', async () => {
    const apps = await appInventory.fetchCatalogApps({});
    assert.ok(apps.length > 0, 'a local roster is expected');
    assert.ok(apps.every((app) => typeof app.slug === 'string'));
  });

  console.log('\nbundled guides');
  const slugs = guideService.bundledGuideSlugs();
  test('every guide this build ships is readable and valid', () => {
    assert.ok(slugs.length >= 3, `expected the catalogue, got ${slugs.join(', ')}`);
    for (const slug of slugs) {
      const guide = guideService.loadBundledGuide(slug);
      assert.strictEqual(guide.appSlug, slug);
      assert.strictEqual(guide.status, 'approved');
      assert.ok(guide.branches.length > 0, `${slug} has no branches`);
      for (const branch of guide.branches) {
        assert.ok(['macos', 'windows'].includes(branch.platform));
        assert.ok(branch.steps.length > 0, `${slug}/${branch.platform} has no steps`);
      }
    }
  });
  test('both platforms are covered, so neither OS lands on an empty panel', () => {
    for (const slug of slugs) {
      const platforms = guideService.loadBundledGuide(slug).branches.map((branch) => branch.platform);
      assert.ok(platforms.includes('windows'), `${slug} is missing windows`);
      assert.ok(platforms.includes('macos'), `${slug} is missing macos`);
    }
  });
  test('every link a guide step points at is on the allowlist', () => {
    for (const slug of slugs) {
      const guide = guideService.loadBundledGuide(slug);
      for (const branch of guide.branches) {
        for (const step of [...branch.setupSteps, ...branch.steps]) {
          if (!step.href) continue;
          const classification = externalLinks.classifyExternalLink(step.href);
          assert.ok(classification.allowed, `${slug}: ${step.href} is blocked, so its button would do nothing`);
        }
      }
    }
  });
  test('a step naming a tool names one GemAir can actually probe', () => {
    for (const slug of slugs) {
      const guide = guideService.loadBundledGuide(slug);
      for (const branch of guide.branches) {
        for (const step of [...branch.setupSteps, ...branch.steps]) {
          if (!step.tool) continue;
          assert.ok(toolVersions.toolSpecFor(step.tool), `${slug}: tool '${step.tool}' is not allowlisted`);
        }
      }
    }
  });
  await testAsync('a missing guide is a sentence, not a stack trace', async () => {
    await assert.rejects(
      () => guideService.fetchGuide({ slug: 'no-such-app' }),
      (error) => /does not ship a guide/i.test(error.message)
    );
  });
  await testAsync('an old guide version is refused with the reason', async () => {
    await assert.rejects(
      () => guideService.fetchGuide({ slug: slugs[0], version: 9999 }),
      (error) => /no longer available/i.test(error.message)
    );
  });
  test('a remote guide source is loopback-only', () => {
    assert.strictEqual(guideService.normalizedApiBase('https://example.com'), null);
    assert.strictEqual(guideService.normalizedApiBase('bundled:'), 'bundled:');
    assert.ok(guideService.normalizedApiBase('http://localhost:3000'));
  });

  console.log('\nrecipes and the autopilot');
  test('every built-in recipe is well formed', () => {
    for (const recipe of recipes.builtinRecipes()) {
      assert.ok(recipe.slug && recipe.appName, 'a recipe needs a slug and a name');
      assert.ok(recipe.steps.length > 0, `${recipe.slug} has no steps`);
      for (const step of recipe.steps) {
        assert.ok(step.id && step.title && step.kind, `${recipe.slug} has a malformed step`);
        if (step.kind === 'command') {
          assert.ok(step.command || step.posixCommand, `${recipe.slug}/${step.id} runs nothing`);
        }
      }
    }
  });
  test('a recipe exists for every bundled guide, as the offline fallback', () => {
    for (const slug of slugs) {
      assert.ok(recipes.recipeForSlug(slug), `no fallback recipe for ${slug}`);
    }
  });
  await testAsync('a guide derives a runnable recipe on both platforms', async () => {
    for (const platform of ['windows', 'macos']) {
      const resolve = guideBackedRecipeResolver({ apiBase: 'bundled:', target: { platform } });
      const recipe = await resolve('excalidraw');
      assert.ok(recipe, `no recipe derived for ${platform}`);
      assert.strictEqual(recipe.slug, 'excalidraw');
      assert.ok(recipe.steps.length > 0);
      assert.strictEqual(recipe.output.type, 'local_web');
    }
  });
  test('garbage can never decode into a runnable guide', () => {
    // The decoder is deliberately lenient — it fills in defaults rather than
    // throwing — so what matters is that its default is UNSHOWABLE: `review`
    // status with no branches, which `guide-service` refuses to publish.
    for (const junk of [{ nonsense: true }, null, 42, 'a string']) {
      const decoded = guideModel.decodeIrisGuide(junk);
      assert.strictEqual(decoded.status, 'review');
      assert.deepStrictEqual(decoded.branches, []);
    }
  });
  test('an unpublished guide is refused by the service that loads it', () => {
    assert.throws(
      () => guideService.validatedGuide({ appSlug: 'x', appName: 'X', status: 'review', branches: [] }, null),
      (error) => /review|not published|isn.t published/i.test(error.message)
    );
  });

  console.log('\nlinks, links, links');
  test('a host that is not on the list is refused by name', () => {
    const classification = externalLinks.classifyExternalLink('https://malware.example/installer.exe');
    assert.strictEqual(classification.allowed, false);
    assert.match(externalLinks.refusalMessage(classification), /malware\.example/);
  });
  test('a URL carrying credentials is never opened', () => {
    assert.strictEqual(externalLinks.classifyExternalLink('https://user:pass@github.com/x').allowed, false);
  });
  test('the routes GemAir itself needs are open', () => {
    for (const url of ['https://opencode.ai/auth', 'https://github.com/excalidraw/excalidraw', 'http://localhost:3000']) {
      assert.ok(externalLinks.classifyExternalLink(url).allowed, `${url} must be openable`);
    }
  });

  console.log('\ndeep links');
  test('a guide link is parsed', () => {
    const result = deepLinks.parseIrisDeepLink('gemair://guide/ollama?version=1');
    assert.ok(result.ok, JSON.stringify(result));
    assert.strictEqual(result.link.kind, 'guide');
    assert.strictEqual(result.link.guide.slug, 'ollama');
  });
  test('an unknown query parameter is rejected rather than ignored', () => {
    const result = deepLinks.parseIrisDeepLink('gemair://guide/ollama?surprise=1');
    assert.strictEqual(result.ok, false);
  });
  test('another app\'s scheme is not ours', () => {
    assert.strictEqual(deepLinks.parseIrisDeepLink('https://example.com/guide/ollama').ok, false);
  });

  console.log('\npointing at things on screen');
  test('a point in image space maps back to the display it came from', () => {
    const mapped = coordinates.imagePointToDisplayPoint(
      { x: 784, y: 400 },
      { width: 1568, height: 800 },
      { x: 0, y: 0, width: 3136, height: 1600 }
    );
    assert.strictEqual(Math.round(mapped.x), 1568);
    assert.strictEqual(Math.round(mapped.y), 800);
  });

  console.log('\nmounting into GemAir');
  test('a subsystem that cannot start never takes the host down', () => {
    const stub = integration.NOT_MOUNTED;
    assert.strictEqual(stub.available, false);
    assert.deepStrictEqual(stub.menuItems(), []);
    assert.strictEqual(stub.trayTooltip(), null);
    assert.doesNotThrow(() => { stub.openChat(); stub.openSettings(); stub.stop(); });
  });
  test('a gemair:// link in argv is recognised', () => {
    assert.ok(integration.argvCarriesDeepLink(['gemair.exe', 'gemair://guide/ollama']));
    assert.ok(!integration.argvCarriesDeepLink(['gemair.exe', '--dev']));
  });
  test('main.js mounts Assist and folds its items into the one tray', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(main.includes("require('./lib/iris/integration')"), 'Assist is not mounted');
    assert.ok(main.includes('assist.menuItems()'), 'the tray does not carry Assist');
    assert.ok(main.includes('assist.stop()'), 'Assist is never torn down');
    assert.strictEqual((main.match(/new Tray\(/g) || []).length, 1, 'there must be exactly one tray');
  });
  test('the Assist preload exposes no way to read a stored secret back', () => {
    const preload = fs.readFileSync(path.join(IRIS, 'preload.js'), 'utf8');
    assert.ok(!/getOpenCodeApiKey|readSecret|getSecret/.test(preload));
    assert.ok(preload.includes("exposeInMainWorld(\"gemair\""));
  });

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
