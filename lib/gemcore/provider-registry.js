'use strict';
/* ============================================================
   GemCore — Provider Registry (ported from ALTREX CODE)
   ------------------------------------------------------------
   A catalog of OpenAI-compatible providers with pinned base
   URLs, official key/docs destinations, and an allowlist guard
   for every external link the app may open. The renderer can
   never make GemAir open an arbitrary URL: only hosts listed
   here, over HTTPS, are permitted.
   ============================================================ */

const PROVIDER_REGISTRY = {
  gemini: {
    id: 'gemini', name: 'Google Gemini', logo: 'G', section: 'recommended', recommended: true,
    description: 'Frontier Flash models with a permanent free tier.',
    apiKeyUrl: 'https://aistudio.google.com/apikey', docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    requiresApiKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    approvedHosts: ['aistudio.google.com', 'ai.google.dev']
  },
  groq: {
    id: 'groq', name: 'Groq', logo: 'GQ', section: 'recommended', recommended: true,
    description: 'Very fast inference for open models.',
    apiKeyUrl: 'https://console.groq.com/keys', docsUrl: 'https://console.groq.com/docs/quickstart',
    requiresApiKey: true, baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-20b',
    approvedHosts: ['console.groq.com']
  },
  cerebras: {
    id: 'cerebras', name: 'Cerebras', logo: 'C', section: 'recommended', recommended: true,
    description: 'Ultra-low-latency cloud inference.',
    apiKeyUrl: 'https://cloud.cerebras.ai/', docsUrl: 'https://inference-docs.cerebras.ai/api-reference/authentication',
    requiresApiKey: true, baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'llama-3.3-70b',
    approvedHosts: ['cloud.cerebras.ai', 'inference-docs.cerebras.ai']
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', logo: 'OR', section: 'additional', recommended: false,
    description: 'One catalog, models from many providers, free tiers included.',
    apiKeyUrl: 'https://openrouter.ai/settings/keys', docsUrl: 'https://openrouter.ai/docs/quickstart',
    requiresApiKey: true, baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'qwen/qwen3-coder:free',
    approvedHosts: ['openrouter.ai']
  },
  nvidia: {
    id: 'nvidia', name: 'NVIDIA NIM', logo: 'N', section: 'additional', recommended: false,
    description: 'Hosted accelerated models for heavy reasoning.',
    apiKeyUrl: 'https://build.nvidia.com/settings/api-keys', docsUrl: 'https://docs.api.nvidia.com/nim/docs/api-quickstart',
    requiresApiKey: true, baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    approvedHosts: ['build.nvidia.com', 'docs.api.nvidia.com']
  },
  openai: {
    id: 'openai', name: 'OpenAI', logo: 'AI', section: 'additional', recommended: false,
    description: 'OpenAI API models for general and agent workflows.',
    apiKeyUrl: 'https://platform.openai.com/api-keys', docsUrl: 'https://platform.openai.com/docs/quickstart',
    requiresApiKey: true, baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
    approvedHosts: ['platform.openai.com']
  },
  ollama: {
    id: 'ollama', name: 'Ollama Local', logo: 'O', section: 'local', recommended: false,
    description: 'Run models locally — no key, nothing leaves this machine.',
    apiKeyUrl: null, installUrl: 'https://ollama.com/download', docsUrl: 'https://docs.ollama.com/',
    requiresApiKey: false, baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder:7b-instruct',
    approvedHosts: ['ollama.com', 'docs.ollama.com']
  },
  custom: {
    id: 'custom', name: 'Custom endpoint', logo: 'API', section: 'advanced', recommended: false,
    description: 'Any trusted OpenAI-compatible endpoint (HTTPS, or local HTTP).',
    apiKeyUrl: null, docsUrl: 'https://platform.openai.com/docs/api-reference',
    requiresApiKey: false, baseUrl: 'https://', defaultModel: '',
    approvedHosts: ['platform.openai.com']
  }
};

const providerDefinitions = Object.values(PROVIDER_REGISTRY);

function providerDefinition(providerId) {
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) throw new Error('Unknown provider: ' + providerId);
  return provider;
}

function isKnownProvider(providerId) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, providerId);
}

/** Only approved official HTTPS destinations can ever be opened externally. */
function officialProviderUrl(providerId, kind) {
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) throw new Error('Could not open the official provider page.');
  const value = kind === 'apiKey' ? provider.apiKeyUrl
    : kind === 'install' ? provider.installUrl
      : provider.docsUrl;
  if (!value) throw new Error('This provider does not offer that destination.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !provider.approvedHosts.includes(url.hostname)) {
    throw new Error('Could not open the official provider page.');
  }
  return url.toString();
}

/** Provider base URLs must be HTTPS; plain HTTP only for loopback. */
function normalizeProviderBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.username || url.password) throw new Error('Provider URLs cannot contain credentials.');
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
    || /^(192\.168|10)\./.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error('Provider endpoint must use HTTPS. HTTP is allowed only for local addresses.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

function providerDisplayName(providerId) {
  try { return providerDefinition(providerId).name; } catch { return 'Provider'; }
}

module.exports = {
  PROVIDER_REGISTRY,
  providerDefinitions,
  providerDefinition,
  isKnownProvider,
  officialProviderUrl,
  normalizeProviderBaseUrl,
  providerDisplayName
};
