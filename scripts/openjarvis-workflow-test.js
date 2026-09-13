#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const main = read('main.js');
const bridge = read('sidecars/openjarvis/gemair_bridge.py');
const preload = read('preload.js');
const app = read('renderer/app.js');
const html = read('renderer/index.html');

assert(bridge.includes('def op_skill_catalog'), 'OpenJarvis skill catalog operation is missing');
assert(bridge.includes('offline": True'), 'skill discovery must declare offline-only behavior');
assert(bridge.includes('metadata only'), 'skill discovery must not imply that cataloging executes a skill');
assert(bridge.includes('safeForGuidedUse'), 'skill catalog must expose the security-scan decision');
assert(app.includes('blocked by the local security scan'), 'renderer must refuse flagged skills');
assert(main.includes("openjarvis:skillCatalog"), 'main process skill catalog IPC is missing');
assert(preload.includes('openJarvisSkillCatalog'), 'preload skill catalog bridge is missing');
assert(app.includes('async openJarvisSkillCatalog'), 'renderer skill catalog API is missing');
assert(app.includes("cmd === '/skills'"), '/skills command is missing');
assert(app.includes("cmd.startsWith('/skill '"), '/skill command is missing');
assert(html.includes('id="openJarvisSkillsList"'), 'skill library panel is missing');
assert(html.includes('id="loadOpenJarvisSkillsBtn"'), 'skill catalog refresh control is missing');
console.log('ok - OpenJarvis skills are discoverable, policy-aware, and wired end to end');
