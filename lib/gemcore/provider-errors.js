'use strict';
/* ============================================================
   GemCore — Provider Error Classification (ported from ALTREX CODE)
   ------------------------------------------------------------
   Turns raw HTTP failures into honest categories: was that a
   bad key, a dead model, a throttle, an exhausted account, or
   an unsupported tool format? Secrets are scrubbed from every
   technical detail before anything is logged or shown.
   ============================================================ */

const ProviderErrorCategory = {
  AUTH_ERROR: 'AUTH_ERROR',
  INVALID_API_KEY: 'INVALID_API_KEY',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  BAD_REQUEST: 'BAD_REQUEST',
  TOOLS_UNSUPPORTED: 'TOOLS_UNSUPPORTED',
  CONTEXT_TOO_LARGE: 'CONTEXT_TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  PROVIDER_SERVER_ERROR: 'PROVIDER_SERVER_ERROR',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN'
};

const CATEGORY_MESSAGES = {
  AUTH_ERROR: 'The provider rejected this credential or account permission.',
  INVALID_API_KEY: 'The provider confirmed that the API key is invalid.',
  MODEL_NOT_FOUND: 'The selected model does not exist on this provider.',
  MODEL_UNAVAILABLE: 'The selected model is currently unavailable.',
  RATE_LIMITED: 'The provider is temporarily rate limited.',
  QUOTA_EXHAUSTED: 'The provider account quota or credits are exhausted.',
  BAD_REQUEST: 'The provider rejected this request format.',
  TOOLS_UNSUPPORTED: 'This model does not support the required tool-calling format.',
  CONTEXT_TOO_LARGE: 'The request exceeds this model\'s context limit.',
  TIMEOUT: 'The provider request timed out.',
  CONNECTION_ERROR: 'GemAir could not connect to the provider.',
  PROVIDER_SERVER_ERROR: 'The provider is temporarily unavailable.',
  CANCELLED: 'The provider request was cancelled.',
  UNKNOWN: 'The provider request failed for an unknown reason.'
};

function redactCredentialShapes(detail) {
  return String(detail || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|nvapi|gsk|or|AIza)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
}

function providerDetail(body) {
  let detail = String(body || '').trim();
  try {
    const parsed = JSON.parse(detail);
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message
      : typeof parsed.message === 'string' ? parsed.message : '';
    const code = parsed.error && (typeof parsed.error.code === 'string' || typeof parsed.error.code === 'number') ? String(parsed.error.code) : '';
    const type = typeof parsed.error?.type === 'string' ? parsed.error.type : '';
    detail = [message, code && ('code=' + code), type && ('type=' + type)].filter(Boolean).join(' | ');
  } catch { /* keep bounded plain text */ }
  return redactCredentialShapes(detail);
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, 60 * 60 * 1000)) : 0;
}

function classifyProviderHttpError(status, body, retryAfter) {
  const source = String(body || '').slice(0, 4000);
  const detail = providerDetail(body);
  const temporaryRate = /too many requests|rate.?limit|temporar|try again|slow down|overload/i.test(source);
  const nonRetryableQuota = /quota[_\s-]*exceeded|quota[_\s-]*failure|(?:per|each)[_\s-]*day|limit\s*[:=]\s*0\b|check (?:your )?(?:plan|billing)|free[_\s-]*tier.*(?:unavailable|not available)|insufficient[_\s-]*(?:fund|balance|credit)|credit[_\s-]*(?:balance|exhausted)|spend[_\s-]*limit|monthly[_\s-]*limit|daily[_\s-]*limit|usage[_\s-]*limit|payment[_\s-]*required/i.test(source);
  const invalidKey = /invalid[_\s-]*(?:api[_\s-]*)?key|incorrect[_\s-]*(?:api[_\s-]*)?key|api key.*(?:invalid|incorrect|expired)|invalid[_\s-]*token/i.test(source);
  const modelMissing = /model.*(?:not found|does not exist|unknown|invalid|retired|deprecated)|no such model/i.test(source);
  const toolsUnsupported = /(?:tool|function)(?:[_\s-]*(?:call|calling|choice))?.*(?:not supported|unsupported|not available)|unsupported.*(?:tool|function)|does not support.*(?:tool|function)/i.test(source);
  const contextTooLarge = /context.*(?:length|window|limit)|too many tokens|token.*(?:limit|maximum)|request too large|maximum context/i.test(source);
  const limitMatch = /(?:limit|maximum)\s*[:=]?\s*([\d,]+)/i.exec(String(body || ''));
  const tokenLimit = limitMatch ? Number(limitMatch[1].replaceAll(',', '')) : undefined;

  let category = ProviderErrorCategory.UNKNOWN;
  if (status === 401) category = invalidKey || !detail ? ProviderErrorCategory.INVALID_API_KEY : ProviderErrorCategory.AUTH_ERROR;
  else if (status === 402) category = ProviderErrorCategory.QUOTA_EXHAUSTED;
  else if (status === 403) category = invalidKey ? ProviderErrorCategory.INVALID_API_KEY : nonRetryableQuota ? ProviderErrorCategory.QUOTA_EXHAUSTED : ProviderErrorCategory.AUTH_ERROR;
  else if (status === 404) category = modelMissing ? ProviderErrorCategory.MODEL_NOT_FOUND : ProviderErrorCategory.MODEL_UNAVAILABLE;
  else if (status === 410) category = ProviderErrorCategory.MODEL_UNAVAILABLE;
  else if (status === 413) category = ProviderErrorCategory.CONTEXT_TOO_LARGE;
  else if (status === 408) category = ProviderErrorCategory.TIMEOUT;
  else if (status === 429) category = nonRetryableQuota ? ProviderErrorCategory.QUOTA_EXHAUSTED : temporaryRate || !nonRetryableQuota ? ProviderErrorCategory.RATE_LIMITED : ProviderErrorCategory.QUOTA_EXHAUSTED;
  else if (status === 400 || status === 422) category = toolsUnsupported ? ProviderErrorCategory.TOOLS_UNSUPPORTED : contextTooLarge ? ProviderErrorCategory.CONTEXT_TOO_LARGE : modelMissing ? ProviderErrorCategory.MODEL_NOT_FOUND : ProviderErrorCategory.BAD_REQUEST;
  else if (status >= 500) category = ProviderErrorCategory.PROVIDER_SERVER_ERROR;

  const retryable = category === ProviderErrorCategory.RATE_LIMITED
    || category === ProviderErrorCategory.TIMEOUT
    || category === ProviderErrorCategory.PROVIDER_SERVER_ERROR;
  return {
    category,
    message: CATEGORY_MESSAGES[category],
    retryable,
    retryAfterMs: parseRetryAfter(retryAfter),
    technicalDetails: detail || ('HTTP ' + status),
    ...(tokenLimit ? { tokenLimit } : {})
  };
}

module.exports = {
  ProviderErrorCategory,
  CATEGORY_MESSAGES,
  classifyProviderHttpError,
  parseRetryAfter,
  redactCredentialShapes
};
