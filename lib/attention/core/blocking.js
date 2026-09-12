'use strict';
/* Gem Air — blocking engine (decision layer).
   Decides IF something should be blocked and WHY. Enforcement is the native layer's job
   (lib/attention/native/enforcer.js on Windows, browser extension for tabs). */

const { stripWww, hostMatches, norm } = require('./classify');
const { activePlanBlocks, sleepStatus } = require('./schedule');

function ruleActive(rule, now) {
  if (!rule || rule.enabled === false) return false;
  if (rule.until && Number(rule.until) < now.getTime()) return false;
  return true;
}

/** Exceptions the user explicitly allowed: { target, kind, until?, reason? } */
function exceptionFor(state, kind, subject, now) {
  const list = (state.blocks && state.blocks.exceptions) || [];
  return list.find((ex) => {
    if (ex.kind !== kind) return false;
    if (ex.until && Number(ex.until) < now.getTime()) return false;
    return kind === 'site' ? hostMatches(subject, ex.target) : norm(ex.target) === norm(subject);
  }) || null;
}

/**
 * Should this context be blocked right now?
 * Sources considered: explicit block lists, active plan rules, sleep mode.
 * @returns {object} { blocked, reason, source, protectedBlock, until, exception }
 */
function evaluate(state, context, now = new Date()) {
  const kind = context.kind === 'site' ? 'site' : 'app';
  const subject = kind === 'site' ? stripWww(context.site) : norm(context.app);
  if (!subject) return { blocked: false };

  const exception = exceptionFor(state, kind, subject, now);

  const hits = [];

  // 1. Explicit block list
  const list = kind === 'site' ? (state.blocks.sites || []) : (state.blocks.apps || []);
  for (const rule of list) {
    if (!ruleActive(rule, now)) continue;
    const match = kind === 'site' ? hostMatches(subject, rule.target) : norm(rule.target) === subject;
    if (!match) continue;
    if (rule.schedule && !withinRuleSchedule(rule.schedule, now)) continue;
    hits.push({
      source: 'blocklist',
      reason: rule.reason || `${kind === 'site' ? subject : context.appLabel} is on your block list`,
      protectedBlock: !!rule.protected,
      until: rule.until || null
    });
  }

  // 2. Active plan rules
  for (const block of activePlanBlocks(state.plans, now)) {
    if (block.kind === 'break') continue;
    const rules = block.rules || {};
    const blockedList = kind === 'site' ? rules.blockedSites : rules.blockedApps;
    const allowedList = kind === 'site' ? rules.allowedSites : rules.allowedApps;
    const matchesList = (arr) => (arr || []).some((t) => (kind === 'site' ? hostMatches(subject, t) : norm(t) === subject));

    if (matchesList(allowedList)) continue;
    let planBlocked = matchesList(blockedList);
    if (!planBlocked && (rules.blockedCategories || []).includes(context.categoryId)) planBlocked = true;
    // Strict mode: inside a focus block only allow-listed things and focus categories survive.
    if (!planBlocked && rules.strict) {
      const allowedCats = rules.allowedCategories || ['work', 'study', 'design', 'development'];
      if (!allowedCats.includes(context.categoryId) && !matchesList(allowedList)) planBlocked = true;
    }
    if (planBlocked) {
      hits.push({
        source: 'plan',
        reason: `${block.planName} — ${block.label} until ${block.end}`,
        protectedBlock: rules.protected !== false,
        planId: block.planId,
        until: null,
        endsInMinutes: block.endsInMinutes
      });
    }
  }

  // 3. Sleep
  const sleep = sleepStatus(state.sleep, now);
  if (sleep.active) {
    const s = state.sleep || {};
    const inCats = (s.blockCategories || []).includes(context.categoryId);
    const inList = kind === 'site'
      ? (s.blockSites || []).some((t) => hostMatches(subject, t))
      : (s.blockApps || []).some((t) => norm(t) === subject);
    if (inCats || inList) {
      hits.push({
        source: 'sleep',
        reason: `Sleep until ${sleep.end}`,
        protectedBlock: true,
        until: null,
        endsInMinutes: sleep.endsInMinutes
      });
    }
  }

  if (!hits.length) return { blocked: false, exception: null };

  // A protected block cannot be waived by an exception.
  const strongest = hits.find((h) => h.protectedBlock) || hits[0];
  if (exception && !strongest.protectedBlock) {
    return { blocked: false, exception, reason: exception.reason || 'Exception allowed', ...strongest, blockedBy: strongest.source };
  }
  if (exception && strongest.protectedBlock && exception.overridesProtected) {
    return { blocked: false, exception, blockedBy: strongest.source };
  }
  return {
    blocked: true,
    kind,
    subject,
    source: strongest.source,
    reason: strongest.reason,
    protectedBlock: !!strongest.protectedBlock,
    until: strongest.until || null,
    endsInMinutes: strongest.endsInMinutes || null,
    exception: exception || null
  };
}

function withinRuleSchedule(schedule, now) {
  const { inWindow } = require('./schedule');
  if (!schedule || !schedule.start || !schedule.end) return true;
  if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(now.getDay())) return false;
  return inWindow(now, schedule.start, schedule.end);
}

/** Site rules the browser extension needs. Computed here so the extension stays dumb. */
function browserPolicy(state, now = new Date()) {
  const blocked = [];
  const seen = new Set();
  const push = (target, reason, prot) => {
    const t = stripWww(target);
    if (!t || seen.has(t)) return;
    seen.add(t);
    blocked.push({ target: t, reason, protected: !!prot });
  };
  for (const rule of state.blocks.sites || []) {
    if (!ruleActive(rule, now)) continue;
    if (rule.schedule && !withinRuleSchedule(rule.schedule, now)) continue;
    push(rule.target, rule.reason || 'Blocked site', rule.protected);
  }
  for (const block of activePlanBlocks(state.plans, now)) {
    if (block.kind === 'break') continue;
    for (const t of (block.rules && block.rules.blockedSites) || []) push(t, `${block.planName} until ${block.end}`, block.rules.protected !== false);
  }
  const sleep = sleepStatus(state.sleep, now);
  if (sleep.active) for (const t of (state.sleep.blockSites || [])) push(t, `Sleep until ${sleep.end}`, true);

  const exceptions = (state.blocks.exceptions || [])
    .filter((ex) => ex.kind === 'site' && (!ex.until || ex.until > now.getTime()))
    .map((ex) => ({ target: stripWww(ex.target), until: ex.until || null, overridesProtected: !!ex.overridesProtected }));

  const categoryRules = (state.siteRules || []).map((r) => ({ match: stripWww(r.match), category: r.category }));
  return { blocked, exceptions, categoryRules, generatedAt: now.getTime() };
}

module.exports = { evaluate, exceptionFor, browserPolicy, withinRuleSchedule };
