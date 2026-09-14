'use strict';
/* ============================================================
   GemCore — Agent Runner (ported from ALTREX CODE + AERA budgets)
   ------------------------------------------------------------
   The provider-facing agent loop: rounds of completion → tool
   calls → observations, with per-task budgets, context
   compaction between rounds, layered provider recovery, and
   honest system-error recovery messages when infrastructure —
   not the model — fails.
   ============================================================ */

const requestManager = require('./request-manager');
const { ProviderErrorCategory } = require('./provider-errors');
const { compactMessages } = require('./request-manager');

const MAX_ROUNDS = 12;
const COMPACT_THRESHOLD_TOKENS = 28000;
const HARD_CONTEXT_TOKENS = 60000;

const SYSTEM_ERROR_RECOVERY = {
  [ProviderErrorCategory.AUTH_ERROR]: 'The provider rejected this credential. Reconnect the provider in AI & Connections settings, then try again.',
  [ProviderErrorCategory.INVALID_API_KEY]: 'The API key is invalid. Paste a fresh key in AI & Connections settings, then try again.',
  [ProviderErrorCategory.MODEL_NOT_FOUND]: 'The selected model no longer exists on this provider. Pick another model in settings.',
  [ProviderErrorCategory.MODEL_UNAVAILABLE]: 'The selected model is temporarily unavailable. Try again shortly or switch models.',
  [ProviderErrorCategory.RATE_LIMITED]: 'The provider is rate limiting requests right now. Waiting a moment and retrying usually resolves it.',
  [ProviderErrorCategory.QUOTA_EXHAUSTED]: 'This provider account is out of quota or credits. Add credits or switch to another connected provider.',
  [ProviderErrorCategory.CONTEXT_TOO_LARGE]: 'The conversation grew beyond this model\'s context window. Start a shorter conversation or switch to a larger-context model.',
  [ProviderErrorCategory.TOOLS_UNSUPPORTED]: 'This model does not support the required tool-calling format. Switch to a model with tool support.',
  [ProviderErrorCategory.TIMEOUT]: 'The provider request timed out. Try again, or use a faster model.',
  [ProviderErrorCategory.CONNECTION_ERROR]: 'GemAir could not reach the provider. Check the network (or the local server) and try again.',
  [ProviderErrorCategory.PROVIDER_SERVER_ERROR]: 'The provider is having trouble right now. Try again in a moment.',
  [ProviderErrorCategory.BAD_REQUEST]: 'The provider rejected the request format. A different model may handle it better.'
};

function recoveryHint(category) {
  return SYSTEM_ERROR_RECOVERY[category] || 'The request failed for an unexpected reason. Try again or switch providers.';
}

/**
 * Run one agent turn to completion.
 *
 * `options`:
 *   complete: async ({ messages, tools }) => { content, toolCalls, finishReason, usage }  (required)
 *   messages: initial message array                                             (required)
 *   tools:    OpenAI tool schemas                                              (optional)
 *   executeTool: async (name, args) => result                                  (required when tools)
 *   budget:   TaskBudget instance                                              (optional)
 *   onEvent:  (event) => void — { type: 'round'|'tool'|'message'|'done'|'error'|'system' }
 *   maxRounds, systemPrompt
 */
async function runAgentTurn(options) {
  const {
    complete, messages, tools = [], executeTool, budget = null,
    onEvent = () => {}, maxRounds = MAX_ROUNDS, requestId
  } = options;

  if (typeof complete !== 'function') throw new Error('agent-runner requires a complete() function');
  if (tools.length > 0 && typeof executeTool !== 'function') throw new Error('agent-runner requires executeTool when tools are provided');

  const workingMessages = [...messages];
  const transcript = [];
  let rounds = 0;
  let totalUsage = { promptTokens: 0, completionTokens: 0 };

  while (rounds < maxRounds) {
    if (budget && !budget.withinLimits()) {
      const reason = budget.exceededReason();
      onEvent({ type: 'system', level: 'warn', message: 'Task budget exhausted (' + reason + '). Stopping the agent loop.' });
      break;
    }

    // Proactive compaction: keep the working set below provider limits.
    const currentTokens = workingMessages.reduce((sum, m) => sum + requestManager.messageTokens(m), 0);
    if (currentTokens > COMPACT_THRESHOLD_TOKENS) {
      const compacted = compactMessages(workingMessages, COMPACT_THRESHOLD_TOKENS - 4000);
      if (compacted.compacted) {
        workingMessages.length = 0;
        workingMessages.push(...compacted.messages);
        onEvent({ type: 'system', level: 'info', message: 'Context compacted (' + compacted.dropped + ' earlier messages summarized) to stay within the model window.' });
      }
    }

    rounds += 1;
    onEvent({ type: 'round', round: rounds });

    let response;
    try {
      response = await complete({ messages: workingMessages, tools, requestId });
    } catch (error) {
      const category = error && error.category;
      const attempts = error && error.attempts;
      onEvent({ type: 'error', category, message: error && error.message, technicalDetails: error && error.technicalDetails, attempts });
      return {
        ok: false, category, message: error && error.message, recovery: recoveryHint(category),
        rounds, transcript, usage: totalUsage, systemError: true
      };
    }

    if (response.usage) {
      totalUsage.promptTokens += response.usage.prompt_tokens || 0;
      totalUsage.completionTokens += response.usage.completion_tokens || 0;
      if (budget) budget.recordTokens((response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0));
    }

    const toolCalls = response.toolCalls || [];
    if (!toolCalls || toolCalls.length === 0) {
      const content = response.content || '';
      onEvent({ type: 'message', content });
      transcript.push({ role: 'assistant', content });
      return { ok: true, content, rounds, transcript, usage: totalUsage, finishReason: response.finishReason };
    }

    workingMessages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCalls.map((call) => ({
        id: call.id || ('call_' + Math.random().toString(36).slice(2, 10)),
        type: 'function',
        function: { name: call.function.name, arguments: call.function.arguments || '{}' }
      }))
    });
    transcript.push({ role: 'assistant', content: response.content || '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      const name = call.function && call.function.name;
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(call.function && call.function.arguments || '{}'); } catch {
        parsedArgs = { _invalidJson: String(call.function && call.function.arguments || '').slice(0, 400) };
      }
      onEvent({ type: 'tool', name, args: parsedArgs, callId: call.id });
      if (budget) budget.recordToolCall();
      let result;
      try {
        result = await executeTool(name, parsedArgs);
      } catch (error) {
        result = { error: String(error && error.message || error).slice(0, 400) };
      }
      let resultText;
      try { resultText = JSON.stringify(result); } catch { resultText = '{"error":"unserializable result"}'; }
      if (resultText.length > 20000) resultText = resultText.slice(0, 20000) + '…[truncated]';
      workingMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      transcript.push({ role: 'tool', name, content: resultText.slice(0, 2000) });
      onEvent({ type: 'tool-result', name, callId: call.id, preview: resultText.slice(0, 400) });
      if (budget && !budget.withinLimits()) break;
    }
  }

  const budgetNote = budget ? ' (' + budget.exceededReason() + ')' : '';
  return {
    ok: true,
    content: 'I stopped after ' + rounds + ' rounds' + budgetNote + '. Here is where things stand — ask me to continue if you want more.',
    rounds, transcript, usage: totalUsage, stoppedEarly: true
  };
}

/**
 * Streaming agent turn: same protections as runAgentTurn, but text
 * deltas are surfaced live as they arrive and tool calls are
 * accumulated from stream fragments before execution.
 *
 * `options.streamComplete({ messages, tools, onEvent, signal, requestId })`
 * must resolve after the stream ends. onEvent receives:
 *   { type: 'round' } | { type: 'delta', text } | { type: 'tool', name, args }
 *   { type: 'tool-result', name, preview } | { type: 'message', content }
 *   { type: 'done'|'error'|'system', ... }
 */
async function runAgentTurnStream(options) {
  const {
    streamComplete, messages, tools = [], executeTool, budget = null,
    onEvent = () => {}, maxRounds = MAX_ROUNDS, requestId, signal
  } = options;

  if (typeof streamComplete !== 'function') throw new Error('runAgentTurnStream requires a streamComplete() function');
  if (tools.length > 0 && typeof executeTool !== 'function') throw new Error('runAgentTurnStream requires executeTool when tools are provided');

  const workingMessages = [...messages];
  let rounds = 0;
  const totalUsage = { promptTokens: 0, completionTokens: 0 };

  while (rounds < maxRounds) {
    if (budget && !budget.withinLimits()) {
      onEvent({ type: 'system', level: 'warn', message: 'Task budget exhausted (' + budget.exceededReason() + '). Stopping the agent loop.' });
      break;
    }

    const currentTokens = workingMessages.reduce((sum, m) => sum + requestManager.messageTokens(m), 0);
    if (currentTokens > COMPACT_THRESHOLD_TOKENS) {
      const compacted = compactMessages(workingMessages, COMPACT_THRESHOLD_TOKENS - 4000);
      if (compacted.compacted) {
        workingMessages.length = 0;
        workingMessages.push(...compacted.messages);
        onEvent({ type: 'system', level: 'info', message: 'Context compacted (' + compacted.dropped + ' earlier messages summarized).' });
      }
    }

    rounds += 1;
    onEvent({ type: 'round', round: rounds });

    let text = '';
    const toolCallAcc = new Map(); // index -> { id, name, arguments }
    let finishReason = null;

    try {
      await streamComplete({
        messages: workingMessages, tools, requestId, signal,
        onEvent: (event) => {
          const delta = event && event.choices && event.choices[0] && event.choices[0].delta;
          const choiceFinish = event && event.choices && event.choices[0] && event.choices[0].finish_reason;
          if (choiceFinish) finishReason = choiceFinish;
          if (!delta) return;
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            onEvent({ type: 'delta', text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const fragment of delta.tool_calls) {
              const index = fragment.index != null ? fragment.index : 0;
              const acc = toolCallAcc.get(index) || { id: '', name: '', arguments: '' };
              if (fragment.id) acc.id = fragment.id;
              if (fragment.function) {
                if (fragment.function.name) acc.name += fragment.function.name;
                if (fragment.function.arguments) acc.arguments += fragment.function.arguments;
              }
              toolCallAcc.set(index, acc);
            }
          }
        }
      });
    } catch (error) {
      const category = error && error.category;
      onEvent({ type: 'error', category, message: error && error.message, technicalDetails: error && error.technicalDetails, recovery: recoveryHint(category) });
      return { ok: false, category, message: error && error.message, recovery: recoveryHint(category), rounds, usage: totalUsage, systemError: true };
    }

    const toolCalls = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]).map(([index, acc]) => ({
      index, id: acc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
      function: { name: acc.name, arguments: acc.arguments || '{}' }
    })).filter((call) => call.function.name);

    if (toolCalls.length === 0) {
      onEvent({ type: 'message', content: text });
      return { ok: true, content: text, rounds, usage: totalUsage, finishReason: finishReason || 'stop' };
    }

    workingMessages.push({
      role: 'assistant',
      content: text || '',
      tool_calls: toolCalls.map((call) => ({ id: call.id, type: 'function', function: call.function }))
    });

    for (const call of toolCalls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch {
        parsedArgs = { _invalidJson: call.function.arguments.slice(0, 400) };
      }
      onEvent({ type: 'tool', name: call.function.name, args: parsedArgs, callId: call.id });
      if (budget) budget.recordToolCall();
      let result;
      try { result = await executeTool(call.function.name, parsedArgs); }
      catch (error) { result = { error: String(error && error.message || error).slice(0, 400) }; }
      let resultText;
      try { resultText = JSON.stringify(result); } catch { resultText = '{"error":"unserializable result"}'; }
      if (resultText.length > 20000) resultText = resultText.slice(0, 20000) + '…[truncated]';
      workingMessages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      onEvent({ type: 'tool-result', name: call.function.name, callId: call.id, preview: resultText.slice(0, 400) });
      if (budget && !budget.withinLimits()) break;
    }
  }

  return {
    ok: true,
    content: 'I stopped after ' + rounds + ' rounds. Ask me to continue if you want more.',
    rounds, usage: totalUsage, stoppedEarly: true
  };
}

module.exports = { runAgentTurn, runAgentTurnStream, recoveryHint, SYSTEM_ERROR_RECOVERY, MAX_ROUNDS };
