'use strict';
/* ============================================================
   GemCore — Tool Broker (ported from AERA)
   ------------------------------------------------------------
   Impact-tiered tool gating: every tool carries a risk tier
   (LOW / MODERATE / HIGH / CRITICAL); higher tiers require
   explicit user approval that can be granted per-task. Adds
   path-traversal defense for file tools and structured audit
   records for every executed action.
   ============================================================ */

const path = require('path');
const fs = require('fs');

const IMPACT_TIERS = { LOW: 'LOW', MODERATE: 'MODERATE', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };

/** GemAir tool → impact tier (mirrors AERA's impact model). */
const TOOL_IMPACT = {
  get_current_time: IMPACT_TIERS.LOW,
  get_current_date: IMPACT_TIERS.LOW,
  get_world_time: IMPACT_TIERS.LOW,
  get_weather: IMPACT_TIERS.LOW,
  web_search: IMPACT_TIERS.LOW,
  search_wikipedia: IMPACT_TIERS.LOW,
  search_youtube: IMPACT_TIERS.LOW,
  fetch_webpage: IMPACT_TIERS.LOW,
  translate: IMPACT_TIERS.LOW,
  get_crypto_price: IMPACT_TIERS.LOW,
  get_stock_price: IMPACT_TIERS.LOW,
  get_clipboard: IMPACT_TIERS.LOW,
  set_clipboard: IMPACT_TIERS.MODERATE,
  open_application: IMPACT_TIERS.MODERATE,
  open_url: IMPACT_TIERS.MODERATE,
  list_directory: IMPACT_TIERS.MODERATE,
  read_file: IMPACT_TIERS.MODERATE,
  search_files: IMPACT_TIERS.MODERATE,
  write_file: IMPACT_TIERS.HIGH,
  run_command: IMPACT_TIERS.CRITICAL,
  send_email: IMPACT_TIERS.HIGH,
  open_whatsapp: IMPACT_TIERS.HIGH,
  computer_control: IMPACT_TIERS.CRITICAL,
  system_settings: IMPACT_TIERS.CRITICAL
};

/** Tier of each allowed root directory for path tools. */
const DIRECTORY_TIERS = {
  [path.join(require('os').homedir(), 'Documents')]: IMPACT_TIERS.MODERATE,
  [path.join(require('os').homedir(), 'Downloads')]: IMPACT_TIERS.MODERATE,
  [path.join(require('os').homedir(), 'Desktop')]: IMPACT_TIERS.MODERATE,
  [require('os').homedir()]: IMPACT_TIERS.HIGH,
  [path.resolve('/')]: IMPACT_TIERS.CRITICAL
};

const FILE_TOOLS = new Set(['read_file', 'write_file', 'list_directory', 'search_files']);
const APPROVAL_TTL_MS = 15 * 60 * 1000; // approvals last for the task window

class ToolBroker {
  /**
   * @param {Function} executor (name, args) => Promise<result> — GemAir's executeTool.
   * @param {Object} [options] { confirm(kind, message) => Promise<boolean>, audit(record) }
   */
  constructor(executor, options = {}) {
    this.executor = executor;
    this.confirm = options.confirm || (async () => false);
    this.auditSink = options.audit || null;
    this.allowedDirectories = null; // null = whole machine with tier gating
    this.grantedApprovals = new Map(); // `${tier}:${fingerprint}` -> expiresAt
    this.sessionApprovals = new Set(); // tiers approved for the whole session
  }

  setAllowedDirectories(directories) {
    this.allowedDirectories = (directories || []).map((dir) => path.resolve(String(dir))).filter(Boolean);
  }

  tierFor(toolName) {
    return TOOL_IMPACT[toolName] || IMPACT_TIERS.HIGH; // unknown tools default to gated
  }

  /** Approve a tier for the rest of the session (explicit user action only). */
  approveTierForSession(tier) {
    if (!Object.values(IMPACT_TIERS).includes(tier)) throw new Error('Unknown impact tier');
    this.sessionApprovals.add(tier);
  }

  revokeSessionApprovals() { this.sessionApprovals.clear(); }

  _approvalFingerprint(toolName, args) {
    const safeArgs = JSON.stringify(args || {});
    return `${toolName}:${safeArgs.slice(0, 400)}`;
  }

  async _requestApproval(toolName, tier, args) {
    if (this.sessionApprovals.has(tier)) return { granted: true, scope: 'session' };
    const fingerprint = this._approvalFingerprint(toolName, args);
    const cached = this.grantedApprovals.get(`${tier}:${fingerprint}`);
    if (cached && cached > Date.now()) return { granted: true, scope: 'task' };
    const humanArgs = JSON.stringify(args || {}).slice(0, 500);
    const message = `GemAir wants to run a ${tier.toLowerCase()}-impact action:\n\n  ${toolName} ${humanArgs}\n\nApprove for this task?`;
    const granted = await this.confirm(tier, message);
    if (granted) {
      this.grantedApprovals.set(`${tier}:${fingerprint}`, Date.now() + APPROVAL_TTL_MS);
      return { granted: true, scope: 'task' };
    }
    return { granted: false, scope: null };
  }

  /** Path safety: normalize and reject traversal escapes above allowed roots. */
  validatePath(toolName, args) {
    if (!FILE_TOOLS.has(toolName)) return { ok: true };
    const raw = args && (args.path || args.file || args.filename);
    if (!raw) return { ok: true }; // executor's own validation will complain
    const resolved = path.resolve(String(raw));
    if (this.allowedDirectories && this.allowedDirectories.length > 0) {
      const inside = this.allowedDirectories.some((root) => {
        const rel = path.relative(root, resolved);
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      });
      if (!inside) {
        return { ok: false, error: 'Permission denied: path is outside the allowed directories.' };
      }
    }
    // Traversal-looking input (e.g. ../../secrets) is resolved away above; still
    // record the original for audit. Only genuinely escaping symlinks are a risk,
    // and those require the file to exist first — real-path check when possible.
    try {
      if (fs.existsSync(resolved)) {
        const real = fs.realpathSync(resolved);
        if (this.allowedDirectories && this.allowedDirectories.length > 0) {
          const inside = this.allowedDirectories.some((root) => {
            const rel = path.relative(fs.realpathSync(root), real);
            return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
          });
          if (!inside) return { ok: false, error: 'Permission denied: resolved path escapes the allowed directories.' };
        }
      }
    } catch { /* stat failures fall through to the executor */ }
    return { ok: true, resolved };
  }

  /** Execute a tool through tiered gating + path safety + audit. */
  async execute(toolName, args, { source = 'agent' } = {}) {
    const tier = this.tierFor(toolName);
    const pathCheck = this.validatePath(toolName, args);
    const startedAt = Date.now();
    const auditRecord = { kind: 'tool', tool: toolName, tier, source, at: startedAt, args: this._auditArgs(toolName, args) };

    if (!pathCheck.ok) {
      auditRecord.outcome = 'denied-path';
      auditRecord.error = pathCheck.error;
      this._audit(auditRecord);
      return { error: pathCheck.error };
    }

    const needsApproval = tier === IMPACT_TIERS.HIGH || tier === IMPACT_TIERS.CRITICAL;
    if (needsApproval) {
      const approval = await this._requestApproval(toolName, tier, args);
      if (!approval.granted) {
        auditRecord.outcome = 'denied-permission';
        this._audit(auditRecord);
        return { error: `Permission denied: ${toolName} is a ${tier.toLowerCase()}-impact action and was not approved.` };
      }
      auditRecord.approval = approval.scope;
    }

    try {
      const result = await this.executor(toolName, args);
      auditRecord.outcome = result && result.error ? 'error' : 'ok';
      auditRecord.durationMs = Date.now() - startedAt;
      if (result && result.error) auditRecord.error = String(result.error).slice(0, 400);
      this._audit(auditRecord);
      return result;
    } catch (error) {
      auditRecord.outcome = 'error';
      auditRecord.durationMs = Date.now() - startedAt;
      auditRecord.error = String(error && error.message || error).slice(0, 400);
      this._audit(auditRecord);
      return { error: auditRecord.error };
    }
  }

  _auditArgs(toolName, args) {
    try {
      const clone = JSON.parse(JSON.stringify(args || {}));
      if (typeof clone.content === 'string') clone.content = clone.content.slice(0, 200) + (clone.content.length > 200 ? '…' : '');
      if (typeof clone.command === 'string') clone.command = clone.command.slice(0, 300);
      if (typeof clone.text === 'string') clone.text = clone.text.slice(0, 200);
      return clone;
    } catch { return { unserializable: true }; }
  }

  _audit(record) {
    if (this.auditSink) {
      try { this.auditSink(record); } catch { /* audit failures never break tools */ }
    }
  }

  /** OpenAI tool schema listing for the given tool names (GemAir signature introspection). */
  static toolSchemas(toolNames, describe) {
    return (toolNames || []).map((name) => ({
      type: 'function',
      function: {
        name,
        description: (describe && describe(name)) || ('GemAir tool: ' + name)
      }
    }));
  }
}

module.exports = { ToolBroker, IMPACT_TIERS, TOOL_IMPACT, DIRECTORY_TIERS };
