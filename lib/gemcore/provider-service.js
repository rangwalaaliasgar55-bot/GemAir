'use strict';
/* ============================================================
   GemCore — Provider Service (ported from ALTREX CODE)
   ------------------------------------------------------------
   Persistent provider configuration + lifecycle: connect with
   a real validation request, fetch live model lists, disconnect,
   per-provider health, and layered recovery across configured
   providers when one fails (auth → quota → connection).
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { providerDefinition, providerDefinitions, normalizeProviderBaseUrl, isKnownProvider } = require('./provider-registry');
const requestManager = require('./request-manager');
const { ProviderErrorCategory } = require('./provider-errors');
const { ModelRegistry } = require('./model-registry');

const CONNECT_TEST_TIMEOUT_MS = 20000;

class ProviderService {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.storePath = path.join(userDataPath, 'gemcore', 'providers.json');
    this.providers = {}; // id -> { provider, label, baseUrl, apiKey, enabled, connected, lastTestedAt, lastError, extraModels }
    this.modelRegistry = new ModelRegistry(userDataPath);
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        for (const [id, config] of Object.entries(parsed)) {
          if (config && typeof config === 'object') this.providers[id] = this._sanitize(id, config);
        }
      }
    } catch { /* corrupt store → start fresh */ }
  }

  _sanitize(id, config) {
    const provider = isKnownProvider(id) ? id : 'custom';
    return {
      provider,
      label: String(config.label || providerDefinition(provider).name).slice(0, 80),
      baseUrl: String(config.baseUrl || providerDefinition(provider).baseUrl),
      apiKey: config.apiKey ? String(config.apiKey) : '',
      enabled: config.enabled !== false,
      connected: !!config.connected,
      lastTestedAt: config.lastTestedAt || null,
      lastError: config.lastError || null,
      extraModels: Array.isArray(config.extraModels) ? config.extraModels.map((m) => String(m)).slice(0, 200) : []
    };
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.providers, null, 2));
    } catch { /* storage failures must not break requests */ }
  }

  /** Public listing: never exposes raw keys to the renderer. */
  listProviders() {
    return providerDefinitions.map((definition) => {
      const config = this.providers[definition.id];
      return {
        ...definition,
        apiKeyUrl: definition.apiKeyUrl,
        configured: !!config,
        connected: !!(config && config.connected),
        enabled: !!(config && config.enabled !== false),
        hasKey: !!(config && config.apiKey),
        label: config ? config.label : definition.name,
        baseUrl: config ? config.baseUrl : definition.baseUrl,
        lastTestedAt: config ? config.lastTestedAt : null,
        lastError: config ? config.lastError : null,
        models: this.modelRegistry.listModels(definition.id, config ? config.extraModels : []),
        defaultModel: this.modelRegistry.resolveModel(definition.id, null, config ? config.extraModels : [])
      };
    });
  }

  getProvider(id) {
    return this.providers[id] || null;
  }

  _saveError(id, classified) {
    const config = this.providers[id];
    if (!config) return;
    config.lastError = {
      category: classified.category,
      message: classified.message,
      technicalDetails: (classified.technicalDetails || '').slice(0, 600),
      at: Date.now()
    };
    if (classified.category === ProviderErrorCategory.INVALID_API_KEY
      || classified.category === ProviderErrorCategory.QUOTA_EXHAUSTED) {
      config.connected = false;
    }
    this._persist();
  }

  _saveSuccess(id) {
    const config = this.providers[id];
    if (!config) return;
    config.connected = true;
    config.lastError = null;
    config.lastTestedAt = Date.now();
    this._persist();
  }

  /** Connect (or re-connect) a provider: stores config, validates with a live models call. */
  async connectProvider({ providerId, label, baseUrl, apiKey, models }) {
    if (!isKnownProvider(providerId)) throw new Error('Unknown provider: ' + providerId);
    const definition = providerDefinition(providerId);
    const config = {
      provider: providerId,
      label: String(label || definition.name).slice(0, 80),
      baseUrl: normalizeProviderBaseUrl(baseUrl || definition.baseUrl),
      apiKey: apiKey ? String(apiKey).trim() : '',
      enabled: true,
      connected: false,
      lastTestedAt: null,
      lastError: null,
      extraModels: Array.isArray(models) ? models.map(String) : []
    };
    if (definition.requiresApiKey && !config.apiKey) {
      throw Object.assign(new Error('An API key is required for this provider.'), {
        code: 'VALIDATION', category: ProviderErrorCategory.INVALID_API_KEY
      });
    }
    this.providers[providerId] = config;
    this._persist();
    return this.testProvider(providerId);
  }

  disconnectProvider(providerId) {
    const config = this.providers[providerId];
    if (!config) return { providerId, connected: false };
    config.connected = false;
    config.enabled = false;
    this._persist();
    return { providerId, connected: false };
  }

  removeProvider(providerId) {
    delete this.providers[providerId];
    this._persist();
    return { providerId, removed: true };
  }

  updateProvider(providerId, { label, apiKey, baseUrl, models }) {
    const config = this.providers[providerId];
    if (!config) throw new Error('Provider is not configured: ' + providerId);
    if (label != null) config.label = String(label).slice(0, 80);
    if (apiKey != null) config.apiKey = String(apiKey).trim();
    if (baseUrl != null) config.baseUrl = normalizeProviderBaseUrl(baseUrl);
    if (models != null) config.extraModels = Array.isArray(models) ? models.map(String).slice(0, 200) : [];
    this._persist();
    return this._publicConfig(providerId, config);
  }

  _publicConfig(id, config) {
    const definition = providerDefinition(config.provider);
    return {
      providerId: id, provider: config.provider, label: config.label,
      baseUrl: config.baseUrl, enabled: config.enabled !== false, connected: config.connected,
      hasKey: !!config.apiKey, requiresApiKey: definition.requiresApiKey,
      lastTestedAt: config.lastTestedAt, lastError: config.lastError,
      models: this.modelRegistry.listModels(config.provider, config.extraModels),
      defaultModel: this.modelRegistry.resolveModel(config.provider, null, config.extraModels)
    };
  }

  /** Live test: GET /models (or a minimal completion for strict providers). */
  async testProvider(providerId) {
    const config = this.providers[providerId];
    if (!config) throw new Error('Provider is not configured: ' + providerId);
    const definition = providerDefinition(config.provider);
    if (definition.requiresApiKey && !config.apiKey) {
      const error = { category: ProviderErrorCategory.INVALID_API_KEY, message: 'An API key is required for this provider.', retryable: false, retryAfterMs: 0, technicalDetails: 'No API key configured' };
      this._saveError(providerId, error);
      return { providerId, connected: false, error };
    }
    try {
      const response = await requestManager.providerRequest({
        provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey,
        path: '/models', method: 'GET', timeoutMs: CONNECT_TEST_TIMEOUT_MS
      });
      const discovered = Array.isArray(response && response.data)
        ? response.data.map((entry) => entry && (entry.id || entry.name)).filter(Boolean) : [];
      const usable = discovered.filter((id) => !/embed|whisper|tts|guard|image|moderation/i.test(id));
      if (usable.length > 0) {
        for (const modelId of usable) {
          this.modelRegistry.markStatus(config.provider, modelId, 'available');
        }
        const known = new Set(this.modelRegistry.listModels(config.provider, config.extraModels).map((m) => m.id));
        const fresh = usable.filter((id) => !known.has(id)).slice(0, 100);
        if (fresh.length > 0) config.extraModels = [...new Set([...(config.extraModels || []), ...fresh])].slice(0, 200);
      }
      this._saveSuccess(providerId);
      return { providerId, connected: true, modelCount: usable.length, models: this.modelRegistry.listModels(config.provider, config.extraModels) };
    } catch (error) {
      const classified = error && error.cause ? error.cause : {
        category: ProviderErrorCategory.UNKNOWN, message: error && error.message || 'The provider test failed.',
        retryable: false, retryAfterMs: 0, technicalDetails: String(error && error.message || '').slice(0, 600)
      };
      this._saveError(providerId, classified);
      return { providerId, connected: false, error: { category: classified.category, message: classified.message, technicalDetails: classified.technicalDetails } };
    }
  }

  /**
   * Layered recovery (ALTREX): try the requested provider first; on
   * failure, walk configured alternates ordered by failure class so
   * one dead key never ends the session.
   */
  async completeWithRecovery({ providerId, model, messages, tools, signal, temperature, maxTokens, requestId }) {
    const order = this.recoveryOrder(providerId);
    const attempts = [];
    for (const candidateId of order) {
      const config = this.providers[candidateId];
      if (!config || config.enabled === false) continue;
      const definition = providerDefinition(config.provider);
      if (definition.requiresApiKey && !config.apiKey) continue;
      const resolvedModel = this.modelRegistry.resolveModel(config.provider, candidateId === providerId ? model : null, config.extraModels);
      try {
        const result = await this.complete({ providerId: candidateId, model: resolvedModel, messages, tools, signal, temperature, maxTokens, requestId });
        return { ...result, providerId: candidateId, model: resolvedModel, recovered: candidateId !== providerId, attempts };
      } catch (error) {
        attempts.push({ providerId: candidateId, category: error && error.category, message: error && error.message });
      }
    }
    const finalError = attempts.length > 0
      ? Object.assign(new Error('All configured providers failed. Last: ' + attempts[attempts.length - 1].message), { attempts })
      : Object.assign(new Error('No connected provider is available. Connect a provider in AI & Connections settings.'), { code: 'NO_PROVIDER' });
    throw finalError;
  }

  /** Configured providers ordered so the requested one is first, then healthy alternates. */
  recoveryOrder(preferredId) {
    const ids = Object.keys(this.providers).filter((id) => {
      const config = this.providers[id];
      return config && config.enabled !== false && !(providerDefinition(config.provider).requiresApiKey && !config.apiKey);
    });
    const score = (id) => {
      const config = this.providers[id];
      let value = 0;
      if (id === preferredId) value -= 100;
      if (config.connected) value -= 10;
      if (config.lastError && Date.now() - (config.lastError.at || 0) < 60000) value += 5;
      return value;
    };
    return ids.sort((a, b) => score(a) - score(b));
  }

  /** Non-streaming chat completion on any configured provider. */
  async complete({ providerId, model, messages, tools, signal, temperature, maxTokens, requestId }) {
    const config = this.providers[providerId];
    if (!config) throw Object.assign(new Error('Provider is not configured: ' + providerId), { category: ProviderErrorCategory.UNKNOWN });
    const body = {
      model: model || this.modelRegistry.resolveModel(config.provider, null, config.extraModels),
      messages,
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens != null ? { max_tokens: maxTokens } : {})
    };
    const response = await requestManager.providerRequest({
      provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey,
      path: '/chat/completions', body, signal, requestId,
      onContextTooLarge: () => {
        const compacted = requestManager.compactMessages(messages, 24000);
        if (compacted.compacted) { body.messages = compacted.messages; return body; }
        return null;
      }
    });
    const choice = response && response.choices && response.choices[0];
    if (!choice) throw Object.assign(new Error('The provider returned an empty response.'), { category: ProviderErrorCategory.PROVIDER_SERVER_ERROR });
    return {
      content: choice.message && choice.message.content || '',
      toolCalls: (choice.message && choice.message.tool_calls) || [],
      finishReason: choice.finish_reason || 'stop',
      usage: response.usage || null,
      model: response.model || body.model
    };
  }

  /** Streaming chat completion; onEvent receives each parsed SSE event. */
  async streamComplete({ providerId, model, messages, tools, signal, temperature, maxTokens, requestId, onEvent }) {
    const config = this.providers[providerId];
    if (!config) throw Object.assign(new Error('Provider is not configured: ' + providerId), { category: ProviderErrorCategory.UNKNOWN });
    const body = {
      model: model || this.modelRegistry.resolveModel(config.provider, null, config.extraModels),
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens != null ? { max_tokens: maxTokens } : {})
    };
    return requestManager.providerRequestStream({
      provider: config.provider, baseUrl: config.baseUrl, apiKey: config.apiKey,
      path: '/chat/completions', body, signal, requestId, onEvent
    });
  }

  /** Health snapshot for diagnostics. */
  status() {
    return this.listProviders().map((entry) => ({
      providerId: entry.id, label: entry.label, configured: entry.configured,
      connected: entry.connected, enabled: entry.enabled, hasKey: entry.hasKey,
      modelCount: entry.models.filter((m) => !m.disabled).length,
      lastTestedAt: entry.lastTestedAt, lastError: entry.lastError
    }));
  }

  diagnostics() {
    return {
      providers: this.status(),
      circuits: requestManager.circuitSnapshot(),
      generatedAt: Date.now()
    };
  }
}

module.exports = { ProviderService };
