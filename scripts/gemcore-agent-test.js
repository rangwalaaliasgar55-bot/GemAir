'use strict';
/* ============================================================
   GemCore agent runtime tests — tool broker (impact tiers,
   path safety, approvals), task budgets, agent runner loops
   (batch + streaming), and the Multi-AI director DAG.
   ============================================================ */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ToolBroker, IMPACT_TIERS } = require('../lib/gemcore/tool-broker');
const { TaskBudget, TaskBudgetRegistry } = require('../lib/gemcore/task-budget');
const { runAgentTurn, runAgentTurnStream, recoveryHint } = require('../lib/gemcore/agent-runner');
const { Director, normalizeTeamPlan, systemPromptForRole } = require('../lib/gemcore/multi-ai');

let passed = 0;
const tests = [];
function ok(label, fn) { tests.push([label, fn]); }
async function runTests() {
  for (const [label, fn] of tests) {
    try { await fn(); passed += 1; }
    catch (error) { console.error('✗ ' + label + ': ' + (error && error.message || error)); process.exitCode = 1; }
  }
  console.log('gemcore-agent-test: ' + passed + ' assertions passed' + (process.exitCode ? ' (WITH FAILURES)' : ''));
}

/* ---------------- tool broker ---------------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemcore-broker-'));
const allowedDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(allowedDir, { recursive: true });

function makeBroker({ confirmResult = false } = {}) {
  const executed = [];
  const audit = [];
  const broker = new ToolBroker(async (name, args) => { executed.push({ name, args }); return { ok: true, tool: name }; }, {
    confirm: async (tier, message) => confirmResult,
    audit: (record) => audit.push(record)
  });
  broker.setAllowedDirectories([allowedDir]);
  return { broker, executed, audit };
}

ok('broker: LOW tools execute without confirmation', async () => {
  const { broker, executed, audit } = makeBroker();
  const result = await broker.execute('get_current_time', {}, { source: 'test' });
  assert.deepEqual(result, { ok: true, tool: 'get_current_time' });
  assert.equal(executed.length, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'ok');
  assert.equal(audit[0].tier, 'LOW');
});

ok('broker: HIGH tools denied without approval, executed with it', async () => {
  const denied = makeBroker({ confirmResult: false });
  const result = await denied.broker.execute('write_file', { path: path.join(allowedDir, 'x.txt'), content: 'hi' });
  assert(result.error && /not approved/.test(result.error));
  assert.equal(denied.executed.length, 0);
  assert.equal(denied.audit[0].outcome, 'denied-permission');

  const approved = makeBroker({ confirmResult: true });
  const okResult = await approved.broker.execute('write_file', { path: path.join(allowedDir, 'x.txt'), content: 'hi' });
  assert.equal(okResult.ok, true);
  assert.equal(approved.executed.length, 1);
  assert.equal(approved.audit[0].outcome, 'ok');
  assert.equal(approved.audit[0].approval, 'task');
});

ok('broker: CRITICAL tools need approval even for repeat calls in-session', async () => {
  const { broker, executed } = makeBroker({ confirmResult: true });
  await broker.execute('run_command', { command: 'echo hi' });
  await broker.execute('run_command', { command: 'echo hi' }); // same fingerprint → cached approval
  assert.equal(executed.length, 2);
  broker.revokeSessionApprovals();
});

ok('broker: unknown tools default to HIGH (gated)', async () => {
  const { broker, executed } = makeBroker({ confirmResult: false });
  const result = await broker.execute('mystery_tool', { x: 1 });
  assert(result.error && /high-impact/.test(result.error));
  assert.equal(executed.length, 0);
});

ok('broker: path traversal above allowed roots is rejected', async () => {
  const { broker, executed } = makeBroker({ confirmResult: true });
  const escape = await broker.execute('write_file', { path: path.join(allowedDir, '..', '..', 'escape.txt'), content: 'x' });
  assert(escape.error && /outside the allowed directories/.test(escape.error));
  assert.equal(executed.length, 0);
  const inside = await broker.execute('write_file', { path: path.join(allowedDir, 'notes', 'deep.txt'), content: 'x' });
  assert.equal(inside.ok, true);
});

ok('broker: session tier approval skips prompts', async () => {
  let confirmations = 0;
  const { broker, executed } = makeBroker({ confirmResult: false });
  broker.confirm = async () => { confirmations += 1; return false; };
  broker.approveTierForSession('HIGH');
  const result = await broker.execute('write_file', { path: path.join(allowedDir, 'a.txt'), content: 'x' });
  assert.equal(result.ok, true);
  assert.equal(confirmations, 0);
  broker.revokeSessionApprovals();
  const denied = await broker.execute('write_file', { path: path.join(allowedDir, 'b.txt'), content: 'x' });
  assert(denied.error);
});

ok('broker: executor exceptions become structured errors, still audited', async () => {
  const audit = [];
  const broker = new ToolBroker(async () => { throw new Error('tool exploded'); }, { audit: (r) => audit.push(r) });
  const result = await broker.execute('get_weather', { city: 'x' });
  assert(result.error && /tool exploded/.test(result.error));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].outcome, 'error');
});

ok('broker: audit args are truncated for big payloads', async () => {
  const audit = [];
  const broker = new ToolBroker(async () => ({ ok: true }), { audit: (r) => audit.push(r) });
  await broker.execute('write_file', { path: '/tmp/x', content: 'A'.repeat(5000) });
  assert(audit[0].args.content.length <= 201);
});

/* ---------------- task budget ---------------- */
ok('budget: enforces token, tool-call, and duration limits', () => {
  const budget = new TaskBudget({ maxTokens: 100, maxToolCalls: 2, maxDurationMs: 50 });
  assert.equal(budget.withinLimits(), true);
  budget.recordTokens(60);
  assert.equal(budget.withinLimits(), true);
  budget.recordTokens(60);
  assert.equal(budget.withinLimits(), false);
  assert.equal(budget.exceededReason(), 'token-budget-exhausted');
  const tools = new TaskBudget({ maxTokens: 1e9, maxToolCalls: 2 });
  tools.recordToolCall();
  assert.equal(tools.exceededReason(), null);
  tools.recordToolCall();
  assert.equal(tools.exceededReason(), 'tool-call-budget-exhausted');
  const duration = new TaskBudget({ maxTokens: 1e9, maxToolCalls: 100, maxDurationMs: 10 });
  assert.equal(duration.exceededReason(), null);
  duration.startedAt = Date.now() - 100;
  assert.equal(duration.exceededReason(), 'duration-budget-exhausted');
  const closed = new TaskBudget({ maxTokens: 1e9, maxToolCalls: 100 });
  closed.close();
  assert.equal(closed.exceededReason(), 'budget-closed');
});

ok('budget registry: create, snapshot, release', () => {
  const registry = new TaskBudgetRegistry();
  const budget = registry.create('task-1', { maxTokens: 10 });
  assert(registry.get('task-1') === budget);
  assert.equal(registry.snapshot('task-1').maxTokens, 10);
  registry.release('task-1');
  assert.equal(registry.get('task-1'), null);
  registry.create('a'); registry.create('b');
  assert.equal(registry.list().length, 2);
  registry.releaseAll();
  assert.equal(registry.list().length, 0);
});

/* ---------------- agent runner (batch) ---------------- */
ok('runner: executes tool calls then finishes with content', async () => {
  const events = [];
  const calls = [];
  const result = await runAgentTurn({
    complete: async ({ messages, tools }) => {
      calls.push({ round: calls.length, toolCount: tools.length, lastRole: messages[messages.length - 1].role });
      if (calls.length === 1) {
        return { content: '', toolCalls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{"city":"Indore"}' } }], finishReason: 'tool_calls' };
      }
      return { content: 'It is 31°C in Indore.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'weather in Indore?' }],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    executeTool: async (name, args) => { calls.push({ tool: name, args }); return { temp: 31 }; },
    onEvent: (event) => events.push(event)
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'It is 31°C in Indore.');
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5 });
  // tool result was fed back as a tool message
  const toolMessages = calls.filter((c) => c.tool === 'get_weather');
  assert.equal(toolMessages.length, 1);
  assert(events.some((e) => e.type === 'tool' && e.name === 'get_weather'));
  assert(events.some((e) => e.type === 'tool-result'));
  assert(events.some((e) => e.type === 'message'));
});

ok('runner: provider failure surfaces category + recovery hint', async () => {
  const result = await runAgentTurn({
    complete: async () => {
      const error = new Error('quota');
      error.category = 'QUOTA_EXHAUSTED';
      error.technicalDetails = 'HTTP 429';
      throw error;
    },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.systemError, true);
  assert.equal(result.category, 'QUOTA_EXHAUSTED');
  assert(/credits|quota/i.test(result.recovery));
  assert(/quota/i.test(recoveryHint('QUOTA_EXHAUSTED')));
});

ok('runner: budget exhaustion stops the loop honestly', async () => {
  let completions = 0;
  const budget = new TaskBudget({ maxTokens: 1, maxToolCalls: 100, maxDurationMs: 60000 });
  budget.recordTokens(5); // already over
  const result = await runAgentTurn({
    complete: async () => { completions += 1; return { content: 'x', toolCalls: [] }; },
    messages: [{ role: 'user', content: 'hi' }],
    budget
  });
  assert.equal(completions, 0);
  assert(result.content.includes('budget'));
  assert.equal(result.stoppedEarly, true);
});

ok('runner: invalid tool JSON is handled without crashing', async () => {
  const result = await runAgentTurn({
    complete: async ({ messages }) => {
      if (messages.length <= 2) {
        return { content: '', toolCalls: [{ id: 'c1', function: { name: 'get_time', arguments: '{not valid json' } }], finishReason: 'tool_calls' };
      }
      return { content: 'recovered', toolCalls: [] };
    },
    messages: [{ role: 'user', content: 'time?' }],
    tools: [{ type: 'function', function: { name: 'get_time' } }],
    executeTool: async (name, args) => (args._invalidJson ? { error: 'bad args' } : { time: 'now' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.content, 'recovered');
});

/* ---------------- agent runner (streaming) ---------------- */
function sseStream(events) {
  const encoder = new TextEncoder();
  const chunks = events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n');
  chunks.push('data: [DONE]\n\n');
  const full = chunks.join('');
  const parts = full.match(/[\s\S]{1,37}/g) || [];
  let index = 0;
  return {
    read: async () => index < parts.length ? { done: false, value: encoder.encode(parts[index++]) } : { done: true, value: undefined },
    cancel: async () => {}
  };
}

ok('runner(stream): deltas surface live; tool calls accumulate from fragments', async () => {
  const deltas = [];
  const toolEvents = [];
  const { parseSseStream } = require('../lib/gemcore/request-manager');
  let streamRound = 0;
  const result = await runAgentTurnStream({
    streamComplete: async ({ onEvent }) => {
      streamRound += 1;
      const reader = streamRound === 1
        // Round 1: text + tool call split across many delta fragments
        ? sseStream([
            { choices: [{ delta: { content: 'Let me check ' } }] },
            { choices: [{ delta: { content: 'the weather.' } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'get_w', arguments: '{"ci' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'eather', arguments: 'ty":"Indore"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
          ])
        // Round 2: final answer
        : sseStream([
            { choices: [{ delta: { content: '31°C and sunny.' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] }
          ]);
      await parseSseStream(reader, { onEvent });
    },
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    executeTool: async (name, args) => {
      toolEvents.push({ name, args });
      return { temp: 31 };
    },
    onEvent: (event) => { if (event.type === 'delta') deltas.push(event.text); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.rounds, 2);
  assert.deepEqual(deltas, ['Let me check ', 'the weather.', '31°C and sunny.']);
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, 'get_weather');
  assert.equal(toolEvents[0].args.city, 'Indore'); // fragments were reassembled
  assert.equal(result.content, '31°C and sunny.');
});

ok('runner(stream): stream errors surface category and recovery', async () => {
  const result = await runAgentTurnStream({
    streamComplete: async () => {
      const error = new Error('invalid key');
      error.category = 'INVALID_API_KEY';
      throw error;
    },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'INVALID_API_KEY');
  assert(/API key is invalid/.test(result.recovery));
});

/* ---------------- multi-ai director ---------------- */
ok('plan: validates structure, unknown deps, duplicates, cycles, and size', () => {
  const good = normalizeTeamPlan({ tasks: [
    { taskId: 'arch', agentId: 'arch', role: 'architect', description: 'design', dependsOn: [] },
    { taskId: 'dev', agentId: 'dev', role: 'developer', description: 'build', dependsOn: ['arch'] },
    { taskId: 'rev', agentId: 'rev', role: 'code reviewer', description: 'review', dependsOn: ['dev'] }
  ] });
  assert.equal(good.agents.length, 3);
  assert.deepEqual(good.executionOrder, ['arch', 'dev', 'rev']);

  assert.throws(() => normalizeTeamPlan({ tasks: [] }), /at least one task/);
  assert.throws(() => normalizeTeamPlan({ tasks: [
    { agentId: 'a', dependsOn: [] }, { agentId: 'a', dependsOn: [] }
  ] }), /Duplicate agent id/);
  assert.throws(() => normalizeTeamPlan({ tasks: [
    { agentId: 'a', dependsOn: ['ghost'] }
  ] }), /unknown agent/);
  assert.throws(() => normalizeTeamPlan({ tasks: [
    { agentId: 'a', dependsOn: ['b'] }, { agentId: 'b', dependsOn: ['a'] }
  ] }), /circular/);
  assert.throws(() => normalizeTeamPlan({ tasks: Array.from({ length: 9 }, (_, i) => ({ agentId: 't' + i, dependsOn: [] })) }), /limited to 8/);
});

ok('plan: empty agents array alias supported', () => {
  const plan = normalizeTeamPlan({ agents: [{ agentId: 'solo', role: 'developer', description: 'all', dependsOn: [] }] });
  assert.equal(plan.agents.length, 1);
});

ok('director: runs the DAG in dependency order, passes upstream outputs downstream', async () => {
  const events = [];
  const callOrder = [];
  const director = new Director({
    complete: async ({ agent, messages }) => {
      callOrder.push(agent.agentId);
      const prompt = messages.map((m) => m.content).join('\n');
      if (agent.agentId === 'dev') {
        assert(prompt.includes('## Upstream work you must build on'), 'dev should receive architect output');
        assert(prompt.includes('blueprint-v1'), 'architect output should be embedded');
      }
      return { content: agent.agentId === 'arch' ? 'blueprint-v1' : 'output-of-' + agent.agentId };
    }
  }, { emit: (event) => events.push(event) });

  director.start({
    tasks: [
      { agentId: 'arch', role: 'architect', description: 'design it', dependsOn: [] },
      { agentId: 'dev', role: 'developer', description: 'build it', dependsOn: ['arch'] },
      { agentId: 'rev', role: 'code reviewer', description: 'review it', dependsOn: ['dev'] }
    ]
  }, { userRequest: 'build a thing' });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const snapshot = director.snapshot();
  assert.equal(snapshot.phase, 'completed');
  assert.deepEqual(callOrder, ['arch', 'dev', 'rev']);
  assert(snapshot.agents.every((agent) => agent.status === 'completed'));
  assert(events.some((e) => e.type === 'session-started'));
  assert(events.some((e) => e.type === 'agent-completed' && e.agentId === 'rev'));
  assert(events.some((e) => e.type === 'session-ended' && e.phase === 'completed'));
});

ok('director: failed dependency marks dependents failed with honest error', async () => {
  const director = new Director({
    complete: async ({ agent }) => {
      if (agent.agentId === 'root') throw new Error('model exploded');
      return { content: 'fine' };
    }
  }, { emit: () => {} });
  director.start({
    tasks: [
      { agentId: 'root', role: 'developer', description: 'd', dependsOn: [] },
      { agentId: 'child', role: 'tester', description: 't', dependsOn: ['root'] }
    ]
  }, { userRequest: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const snapshot = director.snapshot();
  const child = snapshot.agents.find((a) => a.agentId === 'child');
  assert.equal(child.status, 'failed');
  assert(/Dependencies failed: root/.test(child.error));
});

ok('director: independent branches can both proceed; stop cancels', async () => {
  let released = false;
  const director = new Director({
    complete: async ({ agent }) => {
      if (agent.agentId === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { content: 'slow done' };
      }
      return { content: 'fast done' };
    }
  }, { emit: () => {} });
  director.start({
    tasks: [
      { agentId: 'fast', role: 'researcher', description: 'f', dependsOn: [] },
      { agentId: 'slow', role: 'researcher', description: 's', dependsOn: [] }
    ]
  }, { userRequest: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  director.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshot = director.snapshot();
  assert(['cancelled', 'completed'].includes(snapshot.phase));
  released = true;
  assert(released);
});

ok('director: refuses to start while running; role prompts are concrete', () => {
  let resolveSlow;
  const director = new Director({ complete: async () => { await new Promise((r) => { resolveSlow = r; }); return { content: '' }; } }, { emit: () => {} });
  director.start({ tasks: [{ agentId: 'a', role: 'developer', description: 'x', dependsOn: [] }] }, { userRequest: 'x' });
  assert.throws(() => director.start({ tasks: [{ agentId: 'b', dependsOn: [] }] }, { userRequest: 'y' }), /already running/);
  director.stop();
  if (resolveSlow) resolveSlow();
  assert(/Software Architect/.test(systemPromptForRole('Architect')));
  assert(/specialist agent/.test(systemPromptForRole('Chef')));
});

runTests();
