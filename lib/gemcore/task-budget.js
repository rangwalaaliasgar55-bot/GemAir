'use strict';
/* ============================================================
   GemCore — Task Budget (ported from AERA)
   ------------------------------------------------------------
   Every task gets a scoped token + tool-call budget so a runaway
   agent loop cannot burn quota forever. Budgets live for the
   duration of the task, then are released.
   ============================================================ */

class TaskBudget {
  constructor({ maxTokens = 120000, maxToolCalls = 40, maxDurationMs = 10 * 60 * 1000 } = {}) {
    this.maxTokens = maxTokens;
    this.maxToolCalls = maxToolCalls;
    this.maxDurationMs = maxDurationMs;
    this.tokensUsed = 0;
    this.toolCallsUsed = 0;
    this.startedAt = Date.now();
    this.closed = false;
  }

  withinLimits() {
    return !this.closed
      && this.tokensUsed < this.maxTokens
      && this.toolCallsUsed < this.maxToolCalls
      && (Date.now() - this.startedAt) < this.maxDurationMs;
  }

  exceededReason() {
    if (this.closed) return 'budget-closed';
    if (this.tokensUsed >= this.maxTokens) return 'token-budget-exhausted';
    if (this.toolCallsUsed >= this.maxToolCalls) return 'tool-call-budget-exhausted';
    if ((Date.now() - this.startedAt) >= this.maxDurationMs) return 'duration-budget-exhausted';
    return null;
  }

  recordTokens(count) {
    if (Number.isFinite(count) && count > 0) this.tokensUsed += Math.ceil(count);
  }

  recordToolCall() { this.toolCallsUsed += 1; }

  snapshot() {
    return {
      tokensUsed: this.tokensUsed, maxTokens: this.maxTokens,
      toolCallsUsed: this.toolCallsUsed, maxToolCalls: this.maxToolCalls,
      elapsedMs: Date.now() - this.startedAt, maxDurationMs: this.maxDurationMs,
      closed: this.closed, exceeded: this.exceededReason()
    };
  }

  close() { this.closed = true; }
}

/** Registry of live task budgets (one per active task/agent run). */
class TaskBudgetRegistry {
  constructor() { this.budgets = new Map(); }

  create(taskId, options) {
    const budget = new TaskBudget(options);
    this.budgets.set(taskId, budget);
    return budget;
  }

  get(taskId) { return this.budgets.get(taskId) || null; }

  snapshot(taskId) {
    const budget = this.budgets.get(taskId);
    return budget ? budget.snapshot() : null;
  }

  release(taskId) { this.budgets.delete(taskId); }

  releaseAll() { this.budgets.clear(); }

  list() { return [...this.budgets.entries()].map(([id, budget]) => ({ taskId: id, ...budget.snapshot() })); }
}

module.exports = { TaskBudget, TaskBudgetRegistry };
