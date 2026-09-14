'use strict';
/* ============================================================
   GemCore — engine index (ALTREX + AERA systems for GemAir)
   ------------------------------------------------------------
   One require for the whole gemcore suite. main.js wires these
   into IPC; the renderer reaches them through the preload bridge.
   ============================================================ */

const { ProviderService } = require('./provider-service');
const { ModelRegistry, MODEL_STATUS } = require('./model-registry');
const { ToolBroker, IMPACT_TIERS, TOOL_IMPACT } = require('./tool-broker');
const { TaskBudget, TaskBudgetRegistry } = require('./task-budget');
const { Director, normalizeTeamPlan, PLANNING_PROMPT } = require('./multi-ai');
const { runAgentTurn, recoveryHint, SYSTEM_ERROR_RECOVERY } = require('./agent-runner');
const { MemoryStore, MEMORY_SCOPES } = require('./memory-store');
const { AuditLog } = require('./audit');
const { ReasoningTrace, REASONING_LEVELS, classifyReasoningLevel, reasoningScaffoldPrompt } = require('./reasoning');
const { routeModel, scoreReasoningNeed } = require('./model-router');
const requestManager = require('./request-manager');
const { ProviderErrorCategory, classifyProviderHttpError } = require('./provider-errors');
const { providerDefinition, providerDefinitions, officialProviderUrl } = require('./provider-registry');
const emotionProfiles = require('./emotion-profiles');

/** Build the whole gemcore stack for an Electron userData path. */
function createGemCore(userDataPath, { confirm, executeTool, toolDescribe } = {}) {
  const audit = new AuditLog(userDataPath);
  const providerService = new ProviderService(userDataPath);
  const memory = new MemoryStore(userDataPath);
  const budgets = new TaskBudgetRegistry();
  const reasoningTrace = new ReasoningTrace();
  const toolBroker = new ToolBroker(executeTool || (async () => ({ error: 'Tool execution is not available.' })), {
    confirm: confirm || (async () => false),
    audit: (record) => audit.append(record)
  });

  return {
    audit, providerService, memory, budgets, reasoningTrace, toolBroker,
    director: null, // created per session in main.js
    emotionProfiles
  };
}

module.exports = {
  createGemCore,
  ProviderService, ModelRegistry, MODEL_STATUS,
  ToolBroker, IMPACT_TIERS, TOOL_IMPACT,
  TaskBudget, TaskBudgetRegistry,
  Director, normalizeTeamPlan, PLANNING_PROMPT,
  runAgentTurn, recoveryHint, SYSTEM_ERROR_RECOVERY,
  MemoryStore, MEMORY_SCOPES,
  AuditLog, ReasoningTrace, REASONING_LEVELS, classifyReasoningLevel, reasoningScaffoldPrompt,
  routeModel, scoreReasoningNeed,
  requestManager, ProviderErrorCategory, classifyProviderHttpError,
  providerDefinition, providerDefinitions, officialProviderUrl,
  emotionProfiles
};
