#!/usr/bin/env node
/* ============================================================
   GemAir — first-run setup (Node equivalent of Mark-LIV's
   setup.py: OS-aware, friendly failures, one command).

     node scripts/setup.js   (or: npm run setup)

   What it does, in order:
     1. Validates the Node.js version BEFORE npm runs — a wrong
        interpreter fails with one sentence, not a wall of npm
        engine warnings.
     2. Verifies this checkout is complete (package.json, main.js,
        preload.js, renderer/).
     3. Installs npm dependencies for THIS OS only (npm itself
        skips os-ineligible packages; we surface that choice).
     4. Prints the OS-specific system notes Electron actually
        needs (Linux GTK/NSS libs, macOS Xcode CLT, Windows: none).
     5. With --with-browser, additionally installs the Playwright
        Chromium bundle used by browser-automation tooling.
        Off by default: it is a ~160 MB optional engine.

   Flags:
     --check          only validate; install nothing (used by tests)
     --with-browser   also install the browser-automation engine
     --no-color       disable ANSI colors
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REQUIRED_NODE = { major: 22, minor: 12, patch: 0 };
const ROOT = path.join(__dirname, '..');

function colors(enabled) {
  const wrap = (code) => (text) => (enabled ? `[${code}m${text}[0m` : String(text));
  return {
    dim: wrap('2'), ok: wrap('32'), warn: wrap('33'), bad: wrap('31'),
    head: wrap('36;1'), bold: wrap('1')
  };
}

/** "v22.22.3" | "22.12.0" -> { major, minor, patch } (null-safe). */
function parseNodeVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Friendly up-front gate: returns { ok, message }. Never throws. */
function checkNodeVersion(version, required = REQUIRED_NODE) {
  const parsed = typeof version === 'string' ? parseNodeVersion(version) : version;
  if (!parsed) {
    return { ok: false, message: `Could not parse this Node.js version. GemAir needs Node ${required.major}.${required.minor}+ — install a current LTS from https://nodejs.org and run setup again.` };
  }
  const tooOld = parsed.major < required.major
    || (parsed.major === required.major && parsed.minor < required.minor);
  if (tooOld) {
    return {
      ok: false,
      message: `GemAir needs Node.js ${required.major}.${required.minor}.0 or newer — this is ${parsed.major}.${parsed.minor}.${parsed.patch}. Electron and the bundled runtimes will not start on older interpreters. Grab a current LTS from https://nodejs.org (nvm users: \`nvm install --lts\`), then run setup again.`
    };
  }
  return { ok: true, message: `Node.js ${parsed.major}.${parsed.minor}.${parsed.patch} ✓` };
}

/** Sanity: is this a complete GemAir checkout? */
function checkoutProblems(root = ROOT) {
  const problems = [];
  for (const rel of ['package.json', 'main.js', 'preload.js']) {
    if (!fs.existsSync(path.join(root, rel))) problems.push(`missing ${rel}`);
  }
  try {
    if (!fs.readdirSync(path.join(root, 'renderer')).length) problems.push('renderer/ is empty');
  } catch { problems.push('missing renderer/'); }
  return problems;
}

function platformLabel(platform = process.platform) {
  return { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform] || platform;
}

/**
 * OS-specific notes. These are READ-ONLY guidance: system libraries need the
 * OS package manager (sudo), which a dev script must never invoke silently.
 */
function osNotes(platform = process.platform) {
  if (platform === 'linux') {
    return [
      'Electron on Linux needs a few system libraries (Debian/Ubuntu names):',
      '  sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \\',
      '    libdrm2 libgtk-3-0 libgbm1 libasound2 libxss1',
      '(Fedora: libnss3.so / atk / cups-libs / gtk3 / libgbm / alsa-lib — same set.)',
      'No GUI at all (SSH/headless)? \`npm start\` needs a display; use the tests instead.'
    ];
  }
  if (platform === 'darwin') {
    return [
      'If Electron complains about missing command-line tools: xcode-select --install',
      'For signed local builds you need Xcode; running from source needs nothing extra.'
    ];
  }
  if (platform === 'win32') {
    return [
      'Nothing OS-specific to install — Electron brings its own runtime on Windows.',
      'If SmartScreen asks on first run, that is expected for an unsigned dev build.'
    ];
  }
  return ['No OS-specific notes for this platform.'];
}

/** What npm install will do on this OS (for the summary line). */
function osDependencyPlan(platform = process.platform) {
  return {
    platform,
    skipped: platform === 'win32' ? ['fsevents (macOS-only)'] : platform === 'darwin' ? [] : ['fsevents (macOS-only)'],
    note: 'npm automatically skips packages that do not support this OS; nothing Unix-only or Windows-only is forced.'
  };
}

function run(cmd, args, { cwd = ROOT, env } = {}) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: env || process.env, shell: false });
  return result.status === 0;
}

/** npm command differs on Windows (npm is a .cmd shim). */
function npmCmd(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function main(argv = process.argv.slice(2), { platform = process.platform, nodeVersion = process.versions.node } = {}) {
  const useColor = !argv.includes('--no-color') && process.stdout.isTTY !== false;
  const c = colors(useColor);
  const say = (text) => console.log(text);
  const isCheck = argv.includes('--check');
  const withBrowser = argv.includes('--with-browser');

  say(c.head('\n◆ GemAir setup\n'));

  // 1 — Interpreter gate FIRST (Mark-LIV setup.py behavior: a wrong
  // interpreter fails with a sentence, not a wall of package-manager output).
  const nodeCheck = checkNodeVersion(nodeVersion);
  if (!nodeCheck.ok) {
    say(c.bad('✗ ' + nodeCheck.message + '\n'));
    return 1;
  }
  say(c.ok('  ' + nodeCheck.message));

  // 2 — Checkout completeness.
  const problems = checkoutProblems(ROOT);
  if (problems.length) {
    say(c.bad('✗ This does not look like a complete GemAir checkout: ' + problems.join(', ') + '. Re-clone the repository and run setup from its root.'));
    return 1;
  }
  say(c.ok('  GemAir checkout looks complete ✓'));

  // 3 — OS plan.
  const plan = osDependencyPlan(platform);
  say(`  Platform: ${platformLabel(platform)} — ${plan.note}`);
  for (const skipped of plan.skipped) say(c.dim(`    (will skip ${skipped})`));

  if (isCheck) {
    say(c.ok('\n✓ Environment check passed (install skipped: --check).\n'));
    return 0;
  }

  // 4 — npm dependencies.
  say(c.head('\n▸ Installing npm dependencies…'));
  if (!run(npmCmd(platform), ['install', '--no-audit', '--no-fund'])) {
    say(c.bad('\n✗ npm install failed. The full npm output above is the cause — common fixes: check your network/proxy, or delete node_modules and package-lock.json only if you understand the consequences, then re-run setup.'));
    return 1;
  }
  say(c.ok('  Dependencies installed ✓'));

  // 5 — Optional browser-automation engine.
  if (withBrowser) {
    say(c.head('\n▸ Installing the browser-automation engine (Playwright Chromium, ~160 MB)…'));
    if (!run(npmCmd(platform), ['exec', '--yes', '--', 'playwright', 'install', 'chromium', '--with-deps'])) {
      // --with-deps needs sudo on Linux and fails there; the browser itself
      // usually installs fine. Retry without it before giving up.
      say(c.warn('  A system-level dependency step failed — retrying the browser install without it…'));
      if (!run(npmCmd(platform), ['exec', '--yes', '--', 'playwright', 'install', 'chromium'])) {
        say(c.bad('✗ Browser-automation engine install failed. GemAir still works; re-run `npm run setup --with-browser` later to retry.'));
        return 1;
      }
    }
    say(c.ok('  Browser-automation engine ready ✓'));
  }

  // 6 — OS notes + done.
  say('');
  for (const line of osNotes(platform)) say(c.dim('  ' + line));
  say(c.ok(`\n✓ Setup complete. Start GemAir with: ${c.bold('npm start')}${withBrowser ? '' : c.dim('   (browser automation: npm run setup --with-browser)')}\n`));
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { checkNodeVersion, parseNodeVersion, checkoutProblems, osNotes, osDependencyPlan, npmCmd, REQUIRED_NODE };
