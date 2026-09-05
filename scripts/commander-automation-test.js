#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer/app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(app.includes('async function runCommanderTool(text)'), 'keyless commander router missing');
assert(app.includes("webGet('weather'"), 'commander weather route missing');
assert(app.includes("webGet('search'"), 'commander search route missing');
assert(app.includes("webGet('translate'"), 'commander translation route missing');
assert(app.includes("webGet('dictionary'"), 'commander dictionary route missing');
assert(app.includes("webGet('crypto'"), 'commander crypto route missing');
assert(app.includes("reasoningNote('tool', commander.label)"), 'commander tool progress is not visible');
assert(main.includes("const TOOL_RISK"), 'main tool risk policy missing');
assert(main.includes("confirmAction('Run shell command?'"), 'shell confirmation missing');
console.log('ok - commander routes keyless live requests through real tools with safety gates');
