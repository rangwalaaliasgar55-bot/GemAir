'use strict';
/* ============================================================
   GemCore — Multi-AI Director (ported from ALTREX CODE)
   ------------------------------------------------------------
   A director that executes a team plan: agents with roles,
   descriptions, and dependency edges form a DAG. Agents whose
   dependencies complete are scheduled; agents left waiting on
   a failed dependency get an honest synthetic notice. The
   host supplies the completion function; the director owns
   orchestration, status, and events.
   ============================================================ */

const { TaskBudget } = require('./task-budget');

const DIRECTOR_PHASES = ['initializing', 'team-assembled', 'running', 'completed', 'cancelled', 'failed'];

/** Parse + validate a team plan (from the user's planning model or manual input). */
function normalizeTeamPlan(raw) {
  const tasks = Array.isArray(raw && raw.tasks) ? raw.tasks : Array.isArray(raw && raw.agents) ? raw.agents : null;
  if (!tasks || tasks.length === 0) throw new Error('A team plan needs at least one task.');
  if (tasks.length > 8) throw new Error('Team plans are limited to 8 tasks.');

  const seen = new Set();
  const agents = tasks.map((task, index) => {
    const taskId = String(task.taskId || task.id || ('task-' + (index + 1)));
    const agentId = String(task.agentId || taskId);
    if (seen.has(agentId)) throw new Error('Duplicate agent id in team plan: ' + agentId);
    seen.add(agentId);
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.map((dep) => String(dep)) : [];
    const role = String(task.role || task.title || ('Agent ' + (index + 1))).slice(0, 120);
    return {
      taskId, agentId, role,
      description: String(task.description || task.prompt || '').slice(0, 4000),
      dependsOn: [...new Set(dependsOn)],
      status: 'waiting', output: '', error: null, startedAt: null, completedAt: null,
      model: task.model || null
    };
  });

  const agentIds = new Set(agents.map((agent) => agent.agentId));
  for (const agent of agents) {
    for (const dep of agent.dependsOn) {
      if (!agentIds.has(dep)) throw new Error('Agent "' + agent.agentId + '" depends on unknown agent "' + dep + '".');
    }
  }

  // Cycle detection via Kahn's algorithm.
  const indegree = new Map(agents.map((agent) => [agent.agentId, agent.dependsOn.length]));
  const dependents = new Map(agents.map((agent) => [agent.agentId, []]));
  for (const agent of agents) for (const dep of agent.dependsOn) dependents.get(dep).push(agent.agentId);
  const queue = agents.filter((agent) => indegree.get(agent.agentId) === 0).map((agent) => agent.agentId);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== agents.length) throw new Error('Team plan has circular dependencies.');

  return { agents, executionOrder: order };
}

const ROLE_SYSTEM_PROMPTS = {
  'project manager': 'You are the Project Manager. Break the request into a precise plan, define agent tasks, and sequence dependencies. Be concrete and brief.',
  architect: 'You are the Software Architect. Design the technical approach: components, data flow, interfaces. Output concrete structure, not generalities.',
  developer: 'You are the Developer. Implement the requested code completely and correctly. Output working code.',
  'code reviewer': 'You are the Code Reviewer. Audit the work for correctness, security, and clarity. List concrete issues and fixes.',
  tester: 'You are the Tester. Write and reason about tests for the work. Report what passes and what fails concretely.',
  'technical writer': 'You are the Technical Writer. Produce clear, accurate documentation for the work.',
  researcher: 'You are the Researcher. Gather the facts needed for the work. Be precise and cite where knowledge came from.',
  debugger: 'You are the Debugger. Isolate the root cause of the issue and propose the minimal fix.'
};

function systemPromptForRole(role) {
  return ROLE_SYSTEM_PROMPTS[String(role).toLowerCase()] || ('You are a specialist agent on a software team. Your role: ' + role + '. Do your part of the work completely and concretely.');
}

class Director {
  /**
   * @param {Object} host — { complete({ agent, messages, onEvent, signal }) => { content } }
   *   The host performs the actual model calls (with recovery, streaming, etc.)
   * @param {Object} [options] — { emit(event), maxParallel, budgetPerTaskMs }
   */
  constructor(host, options = {}) {
    if (!host || typeof host.complete !== 'function') throw new Error('Director requires a host with complete()');
    this.host = host;
    this.emit = options.emit || (() => {});
    this.maxParallel = options.maxParallel || 1; // ALTREX runs agents sequentially
    this.session = null;
  }

  start(planInput, { userRequest } = {}) {
    if (this.session && this.session.phase === 'running') throw new Error('A director session is already running.');
    const plan = normalizeTeamPlan(planInput);
    const sessionId = 'director-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    this.session = {
      sessionId, userRequest: String(userRequest || ''),
      phase: 'initializing', agents: plan.agents, executionOrder: plan.executionOrder,
      startedAt: Date.now(), completedAt: null, errors: []
    };
    this.emit({ type: 'session-started', sessionId, agentCount: plan.agents.length });
    this.session.phase = 'team-assembled';
    this.emit({ type: 'phase', phase: this.session.phase });
    this._tick();
    return this.snapshot();
  }

  snapshot() {
    if (!this.session) return null;
    const session = this.session;
    return {
      sessionId: session.sessionId,
      userRequest: session.userRequest,
      phase: session.phase,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      errors: session.errors,
      agents: session.agents.map((agent) => ({
        taskId: agent.taskId, agentId: agent.agentId, role: agent.role,
        description: agent.description, dependsOn: agent.dependsOn,
        status: agent.status, error: agent.error,
        outputPreview: agent.output ? agent.output.slice(0, 300) : '',
        startedAt: agent.startedAt, completedAt: agent.completedAt
      }))
    };
  }

  stop() {
    if (!this.session) return null;
    if (this.session.phase === 'running') {
      this.session.phase = 'cancelled';
      for (const agent of this.session.agents) {
        if (agent.status === 'running' || agent.status === 'waiting') agent.status = 'cancelled';
      }
      this.emit({ type: 'phase', phase: 'cancelled' });
    }
    const snapshot = this.snapshot();
    if (this.session.abortController) this.session.abortController.abort(new Error('Director session cancelled'));
    this.session.completedAt = Date.now();
    this.emit({ type: 'session-ended', phase: this.session.phase });
    return snapshot;
  }

  _completed(agentId) {
    const agent = this.session.agents.find((a) => a.agentId === agentId);
    return agent && (agent.status === 'completed' || agent.status === 'failed');
  }

  _tick() {
    if (!this.session || this.session.phase === 'cancelled') return;
    const pending = this.session.agents.filter((agent) => agent.status === 'waiting'
      && agent.dependsOn.every((dep) => this._completed(dep)));
    if (pending.length === 0) {
      const stillActive = this.session.agents.some((agent) => agent.status === 'waiting' || agent.status === 'running');
      if (!stillActive && this.session.phase === 'running') this._finish();
      else if (!stillActive && this.session.phase !== 'running') this._finish();
      return;
    }
    // Release agents whose dependencies failed with an honest notice.
    for (const agent of pending) {
      const failedDeps = agent.dependsOn.filter((dep) => {
        const depAgent = this.session.agents.find((a) => a.agentId === dep);
        return depAgent && depAgent.status === 'failed';
      });
      if (failedDeps.length > 0 && failedDeps.length === agent.dependsOn.length) {
        agent.status = 'failed';
        agent.error = 'Dependencies failed: ' + failedDeps.join(', ');
        this.emit({ type: 'agent-failed', agentId: agent.agentId, error: agent.error });
      }
    }
    const ready = this.session.agents.filter((agent) => agent.status === 'waiting'
      && agent.dependsOn.every((dep) => this._completed(dep)));
    if (ready.length === 0) {
      const stillActive = this.session.agents.some((agent) => agent.status === 'waiting' || agent.status === 'running');
      if (!stillActive) this._finish();
      return;
    }
    if (this.session.phase !== 'running') {
      this.session.phase = 'running';
      this.emit({ type: 'phase', phase: 'running' });
    }
    const launchCount = Math.max(0, this.maxParallel - this.session.agents.filter((a) => a.status === 'running').length);
    for (const agent of ready.slice(0, launchCount)) this._runAgent(agent);
    if (launchCount === 0 && !this.session.agents.some((a) => a.status === 'running')) this._finish();
  }

  async _runAgent(agent) {
    agent.status = 'running';
    agent.startedAt = Date.now();
    this.emit({ type: 'agent-started', agentId: agent.agentId, role: agent.role });
    this.session.abortController = this.session.abortController || new AbortController();

    const dependencyNotes = agent.dependsOn.map((dep) => {
      const depAgent = this.session.agents.find((a) => a.agentId === dep);
      return '### Work from ' + dep + ' (' + depAgent.role + ')\n' + (depAgent.output || '(no output)');
    }).join('\n\n');

    const messages = [
      { role: 'system', content: systemPromptForRole(agent.role) },
      {
        role: 'user',
        content: [
          this.session.userRequest ? ('## User request\n' + this.session.userRequest) : '',
          '## Your assignment\n' + (agent.description || agent.role),
          dependencyNotes ? ('## Upstream work you must build on\n' + dependencyNotes) : '',
          'Complete your assignment now. Output only your deliverable.'
        ].filter(Boolean).join('\n\n')
      }
    ];

    try {
      const result = await this.host.complete({
        agent, messages, signal: this.session.abortController.signal,
        onEvent: (event) => this.emit({ ...event, agentId: agent.agentId, type: event.type === 'message' ? 'agent-message' : event.type })
      });
      agent.output = String(result && result.content || '').slice(0, 60000);
      agent.status = 'completed';
      agent.completedAt = Date.now();
      this.emit({ type: 'agent-completed', agentId: agent.agentId, outputPreview: agent.output.slice(0, 400) });
    } catch (error) {
      if (this.session.phase === 'cancelled') return;
      agent.status = 'failed';
      agent.error = String(error && error.message || error).slice(0, 600);
      agent.completedAt = Date.now();
      this.session.errors.push({ agentId: agent.agentId, message: agent.error });
      this.emit({ type: 'agent-failed', agentId: agent.agentId, error: agent.error });
    } finally {
      if (this.session.phase !== 'cancelled') this._tick();
    }
  }

  _finish() {
    if (!this.session) return;
    const failed = this.session.agents.filter((agent) => agent.status === 'failed').length;
    this.session.phase = failed === this.session.agents.length ? 'failed' : 'completed';
    this.session.completedAt = Date.now();
    this.emit({ type: 'phase', phase: this.session.phase });
    this.emit({
      type: 'session-ended', phase: this.session.phase,
      summary: this._composeSummary()
    });
  }

  _composeSummary() {
    const completed = this.session.agents.filter((a) => a.status === 'completed');
    return [
      'Team run ' + this.session.phase + '.',
      completed.length + '/' + this.session.agents.length + ' agents finished their assignments.',
      ...completed.map((agent) => '— ' + agent.role + ' (' + agent.agentId + ')')
    ].join('\n');
  }
}

/** Build the planning prompt used to generate a team plan from a user request. */
const PLANNING_PROMPT = `You are the Director of a small team of AI agents. Break the user's request into a plan of 2-5 tasks (max 8) that together complete it.

Respond with ONLY a JSON object (no markdown fences, no prose):
{
  "tasks": [
    {
      "taskId": "short-kebab-id",
      "agentId": "same-as-taskId",
      "role": "architect | developer | code reviewer | tester | researcher | debugger | technical writer",
      "description": "One clear paragraph telling this agent exactly what to produce.",
      "dependsOn": ["agentId of tasks that must finish first, or []"],
      "model": null
    }
  ]
}

Rules:
- The first task must have dependsOn: [].
- Every dependsOn entry must match another task's agentId exactly.
- No circular dependencies.
- Each task must produce a concrete deliverable the next agent can build on.`;

module.exports = { Director, normalizeTeamPlan, PLANNING_PROMPT, DIRECTOR_PHASES, systemPromptForRole };
