'use strict';

const fs = require('fs');
const path = require('path');

const backupTimes = new Map();

function cloneFallback(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function readObject(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function writeJsonAtomic(file, value, options = {}) {
  const maxBytes = Number(options.maxBytes) || 2 * 1024 * 1024;
  const backup = options.backup !== false;
  const backupInterval = Number(options.backupInterval) || 5 * 60 * 1000;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (backup && fs.existsSync(file) && Date.now() - (backupTimes.get(file) || 0) >= backupInterval) {
      if (readObject(file, maxBytes)) {
        try { fs.copyFileSync(file, file + '.bak'); backupTimes.set(file, Date.now()); } catch {}
      }
    }
    const payload = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(payload, 'utf8') > maxBytes) return false;
    fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function readJsonRecovering(file, fallback, options = {}) {
  const maxBytes = Number(options.maxBytes) || 2 * 1024 * 1024;
  const primary = readObject(file, maxBytes);
  if (primary) return primary;
  const backup = readObject(file + '.bak', maxBytes);
  if (backup) {
    writeJsonAtomic(file, backup, { maxBytes, backup: false });
    return backup;
  }
  return cloneFallback(fallback);
}

function removeJsonStore(file) {
  for (const target of [file, file + '.bak']) {
    try { fs.unlinkSync(target); } catch {}
  }
  backupTimes.delete(file);
}

module.exports = { readJsonRecovering, writeJsonAtomic, removeJsonStore };
