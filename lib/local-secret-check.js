'use strict';
/* ============================================================
   GemAir — local-secret git-tracking guard.
   ------------------------------------------------------------
   Shaped by Mark-LIV's local-first privacy posture (plaintext
   config, self-signed certs and memory files called out
   explicitly in .gitignore "so a fork or pull request cannot
   leak them by accident").

   GemAir keeps secrets outside the repo (keys are encrypted in
   the OS credential store), but anyone running from a source
   checkout can still export a memory backup, drop an .env, or
   generate a cert into the working tree. This guard runs at
   startup: if the app directory is a git checkout and git itself
   reports a sensitive file as *tracked*, we surface a warning —
   because .gitignore only protects untracked files, and a file
   already in git history is already leaked if pushed.
   ============================================================ */

const path = require('path');
const { execFile } = require('child_process');

// Path patterns (matched against repo-relative `git ls-files` output)
// that should NEVER be tracked in a GemAir fork or clone.
const SENSITIVE_PATTERNS = [
  { re: /^\.env($|\.)/i, id: 'dotenv', label: 'environment file (.env*)' },
  { re: /(^|\/)\.env($|\.)/i, id: 'dotenv', label: 'environment file (.env*)' },
  { re: /api[_-]?keys?\.(json|ya?ml|env|txt)$/i, id: 'api_keys', label: 'API key file' },
  { re: /\.(pem|crt|key|p12|pfx)$/i, id: 'cert', label: 'certificate or private key' },
  { re: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i, id: 'ssh', label: 'SSH private key' },
  { re: /gemair-(memory|profile|backup|secrets?)[^/]*\.json$/i, id: 'local_state', label: 'exported local memory/profile' },
  { re: /(^|\/)memory(-backup|-export|-dump)?[^/]*\.(json|txt)$/i, id: 'local_state', label: 'local memory export' },
  { re: /(^|\/)config\/(secrets?|credentials?)\./i, id: 'config_secrets', label: 'config secrets' }
];

// Files that pattern-match but are intentionally tracked templates.
const ALLOW_LIST = new Set([
  '.env.example', '.env.sample', '.env.template'
]);

function classifyTrackedFiles(repoRelPaths) {
  const hits = [];
  for (const raw of Array.isArray(repoRelPaths) ? repoRelPaths : []) {
    const rel = String(raw || '').trim();
    if (!rel || ALLOW_LIST.has(rel)) continue;
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.re.test(rel)) {
        hits.push({ file: rel, kind: pattern.id, label: pattern.label });
        break;
      }
    }
  }
  return hits;
}

/**
 * Ask git which files are tracked in `repoDir` and classify them.
 * Never throws — a non-git folder, missing git binary, or a hung
 * child all resolve to { checked: false }.
 * `runGit` is injectable for tests: (dir, args) => Promise<stdout string>.
 */
function defaultRunGit(dir, args) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: dir, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
    child.on('error', reject);
  });
}

async function findTrackedSecrets(repoDir, { runGit = defaultRunGit, fsImpl = require('fs') } = {}) {
  const dir = String(repoDir || '');
  if (!dir) return { checked: false, reason: 'NO_DIR', hits: [] };
  try {
    if (!fsImpl.existsSync(path.join(dir, '.git'))) return { checked: false, reason: 'NOT_A_CHECKOUT', hits: [] };
  } catch { return { checked: false, reason: 'NOT_A_CHECKOUT', hits: [] }; }
  let out = '';
  try {
    out = await runGit(dir, ['ls-files', '-z']);
  } catch (error) {
    return { checked: false, reason: 'GIT_FAILED', message: String((error && error.message) || error).slice(0, 200), hits: [] };
  }
  const files = out.split('\0').filter(Boolean);
  return { checked: true, hits: classifyTrackedFiles(files), totalTracked: files.length };
}

/** `.gitignore` lines every fork should carry (used by docs + tests). */
const RECOMMENDED_GITIGNORE = [
  '# Never commit local secrets (Mark-style local-first hardening)',
  '.env',
  '.env.*',
  '!.env.example',
  '**/api_keys.json',
  '**/*.pem',
  '**/*.crt',
  '**/*.key',
  'config/certs/',
  'gemair-memory*.json',
  'gemair-profile*.json',
  'memory-backup*.json'
];

module.exports = { findTrackedSecrets, classifyTrackedFiles, SENSITIVE_PATTERNS, RECOMMENDED_GITIGNORE };
