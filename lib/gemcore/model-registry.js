'use strict';
/* ============================================================
   GemCore — Model Registry (ported from ALTREX CODE)
   ------------------------------------------------------------
   Local, persistent catalog of provider models with health
   status (available / deprecated / unknown), user-disabled
   models, and default-model resolution with fallback chains
   so a retired default never strands a provider.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { providerDefinition } = require('./provider-registry');

const MODEL_STATUS = { AVAILABLE: 'available', DEPRECATED: 'deprecated', UNKNOWN: 'unknown' };

const BUILTIN_MODELS = {
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', status: 'available', context: 1048576 },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', status: 'available', context: 1048576 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', status: 'available', context: 1048576 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', status: 'available', context: 1048576 }
  ],
  groq: [
    { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B', status: 'available', context: 131072 },
    { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', status: 'available', context: 131072 },
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', status: 'available', context: 128000 },
    { id: 'qwen/qwen3-32b', name: 'Qwen 3 32B', status: 'available', context: 131072 }
  ],
  cerebras: [
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', status: 'available', context: 128000 },
    { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B', status: 'available', context: 128000 }
  ],
  openrouter: [
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)', status: 'available', context: 262144 },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (free)', status: 'available', context: 163840 },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)', status: 'available', context: 131072 }
  ],
  nvidia: [
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1', name: 'Nemotron Super 49B', status: 'available', context: 128000 }
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', status: 'available', context: 128000 },
    { id: 'gpt-4o', name: 'GPT-4o', status: 'available', context: 128000 }
  ],
  ollama: [],
  custom: []
};

const REASONING_HINTS = /\b(r1|thinking|reason-?er|qwq|mixtral-thinking|o1|o3|o4)\b/i;

class ModelRegistry {
  constructor(userDataPath) {
    this.storePath = path.join(userDataPath, 'gemcore', 'models.json');
    this.store = { disabled: {}, removed: {}, defaults: {}, catalogRevision: 1 };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        this.store = {
          disabled: parsed.disabled || {},
          removed: parsed.removed || {},
          defaults: parsed.defaults || {},
          catalogRevision: parsed.catalogRevision || 1
        };
      }
    } catch (error) {
      this.store = { disabled: {}, removed: {}, defaults: {}, catalogRevision: 1 };
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2));
    } catch { /* storage failures must not break requests */ }
  }

  /** All usable models for a provider: builtin catalog + user-added, minus removed/disabled. */
  listModels(providerId, extraModels = []) {
    const provider = providerDefinition(providerId);
    const disabled = new Set(this.store.disabled[providerId] || []);
    const removed = new Set(this.store.removed[providerId] || []);
    const builtin = (BUILTIN_MODELS[providerId] || []).map((model) => ({
      ...model,
      providerId,
      reasoning: REASONING_HINTS.test(model.id),
      default: model.id === provider.defaultModel
    }));
    const extras = (extraModels || []).map((model) => {
      const id = typeof model === 'string' ? model : model.id;
      return { id, name: typeof model === 'string' ? model : (model.name || id), status: MODEL_STATUS.UNKNOWN, providerId, reasoning: REASONING_HINTS.test(id), default: id === provider.defaultModel, context: (model && model.context) || undefined };
    });
    const seen = new Set();
    const models = [];
    for (const model of [...builtin, ...extras]) {
      if (removed.has(model.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({ ...model, disabled: disabled.has(model.id) });
    }
    return models;
  }

  /** Resolve the model to use: user default → provider default → first available. */
  resolveModel(providerId, requestedModel, extraModels = []) {
    const models = this.listModels(providerId, extraModels).filter((model) => !model.disabled);
    if (models.length === 0) return providerDefinition(providerId).defaultModel || null;
    if (requestedModel && models.some((model) => model.id === requestedModel)) return requestedModel;
    const userDefault = this.store.defaults[providerId];
    if (userDefault && models.some((model) => model.id === userDefault)) return userDefault;
    const providerDefault = models.find((model) => model.default);
    return (providerDefault || models[0]).id;
  }

  setDefault(providerId, modelId) {
    const models = this.listModels(providerId);
    if (modelId && !models.some((model) => model.id === modelId)) throw new Error('Unknown model for this provider: ' + modelId);
    if (modelId) this.store.defaults[providerId] = modelId;
    else delete this.store.defaults[providerId];
    this.persist();
    return this.listModels(providerId);
  }

  setDisabled(providerId, modelId, disabled) {
    const models = this.listModels(providerId);
    if (!models.some((model) => model.id === modelId)) {
      this.store.disabled[providerId] = this.store.disabled[providerId] || [];
      if (disabled && !this.store.disabled[providerId].includes(modelId)) this.store.disabled[providerId].push(modelId);
    } else {
      this.store.disabled[providerId] = this.store.disabled[providerId] || [];
      const set = new Set(this.store.disabled[providerId]);
      if (disabled) set.add(modelId); else set.delete(modelId);
      this.store.disabled[providerId] = [...set];
    }
    this.persist();
    return this.listModels(providerId);
  }

  removeModel(providerId, modelId) {
    this.store.removed[providerId] = this.store.removed[providerId] || [];
    if (!this.store.removed[providerId].includes(modelId)) this.store.removed[providerId].push(modelId);
    this.persist();
    return this.listModels(providerId);
  }

  restoreModel(providerId, modelId) {
    this.store.removed[providerId] = (this.store.removed[providerId] || []).filter((id) => id !== modelId);
    this.persist();
    return this.listModels(providerId);
  }

  markStatus(providerId, modelId, status) {
    // Status observations from live tests are kept in-memory; builtin catalog
    // remains the durable source of truth between releases.
    if (!this._observed) this._observed = {};
    if (!this._observed[providerId]) this._observed[providerId] = {};
    this._observed[providerId][modelId] = { status, at: Date.now() };
  }

  observedStatus(providerId, modelId) {
    return this._observed && this._observed[providerId] && this._observed[providerId][modelId]
      ? this._observed[providerId][modelId].status : null;
  }
}

module.exports = { ModelRegistry, MODEL_STATUS, BUILTIN_MODELS };
