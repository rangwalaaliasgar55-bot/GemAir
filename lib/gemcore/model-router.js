'use strict';
/* ============================================================
   GemCore — Model Router (ported from ALTREX CODE)
   ------------------------------------------------------------
   Routes each completion between a reasoning tier (deliberate,
   tool-heavy, multi-step work) and a direct tier (fast chat,
   tool-free answers). Providers can define separate models for
   each tier; the router decides per request.
   ============================================================ */

const DIRECT_TASK_HINTS = /\b(hi|hello|hey|thanks|thank you|ok|okay|cool|nice|yes|no|sure|good)\b/i;
const REASONING_TASK_HINTS = /\b(why|explain|analy[sz]e|compare|plan|design|debug|refactor|step[- ]by[- ]step|strategy|architect|root cause|trade[- ]?off|evaluate|reason)\b/i;
const TOOL_HINTS = /\b(file|directory|folder|run|execute|open|launch|search|find|list|create|write|read|install|shell|terminal|command)\b/i;

function scoreReasoningNeed({ messages, tools, userText } = {}) {
  let score = 0;
  const text = String(userText || lastUserText(messages) || '');
  if (text) {
    if (DIRECT_TASK_HINTS.test(text.trim()) && text.trim().length < 40) score -= 2;
    if (REASONING_TASK_HINTS.test(text)) score += 2;
    if (text.length > 600) score += 1;
    if ((text.match(/\?/g) || []).length > 2) score += 1;
  }
  if (Array.isArray(tools) && tools.length > 0) score += 2;
  if (messages && messages.length > 12) score += 1;
  return score;
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user') {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) return message.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ');
      return '';
    }
  }
  return '';
}

/**
 * Choose between reasoning and direct models.
 * `models`: { reasoning: modelId|null, direct: modelId|null, default: modelId }
 */
function routeModel(models, context = {}) {
  const score = scoreReasoningNeed(context);
  const wantsReasoning = score >= 2;
  const reasoning = models && models.reasoning;
  const direct = models && (models.direct || models.default);
  const chosen = wantsReasoning && reasoning ? reasoning : direct;
  return {
    model: chosen || (models && models.default) || null,
    tier: wantsReasoning && reasoning ? 'reasoning' : 'direct',
    score
  };
}

module.exports = { routeModel, scoreReasoningNeed };
