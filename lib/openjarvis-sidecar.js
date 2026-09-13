'use strict';

/**
 * OpenJarvis Python/Rust sidecar controller.
 *
 * The full upstream Python and Rust implementation is shipped in
 * sidecars/openjarvis. This controller creates an isolated venv in GemAir's
 * user-data directory, builds the optional Rust extension when a toolchain is
 * present, and speaks bounded JSON-lines over stdio. No listener is exposed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const OPENJARVIS_REVISION = 'b1055c983b25b298c7e97723847d215df18de4a8';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PROTOCOL_BUFFER = 2 * 1024 * 1024;
let configuredRuntimeRoot = '';
let configuredResourceRoot = '';
let configuredOptions = {};
let configuredOptionsKey = '{}';
let processHandle = null;
let processBuffer = '';
let nextRequestId = 1;
let installPromise = null;
let installChild = null;
let installCancelled = false;
let startPromise = null;
let lastError = '';
const pending = new Map();

function configure(options = {}) {
  if (processHandle) throw new Error('OPENJARVIS_ALREADY_RUNNING');
  if (options.runtimeRoot) configuredRuntimeRoot = path.resolve(String(options.runtimeRoot));
  if (options.resourceRoot) configuredResourceRoot = path.resolve(String(options.resourceRoot));
  if (options.settings) setRuntimeOptions(options.settings);
}

function normalizeRuntimeOptions(options = {}) {
  return {
    engine: String(options.engine || 'ollama'),
    model: String(options.model || ''),
    ollamaHost: String(options.ollamaHost || 'http://127.0.0.1:11434'),
    mcpEnabled: options.mcpEnabled === true,
    mcpUrl: String(options.mcpUrl || '')
  };
}

function setRuntimeOptions(options = {}) {
  const next = normalizeRuntimeOptions(options);
  const key = JSON.stringify(next);
  if (key !== configuredOptionsKey && processHandle) stop();
  configuredOptions = next;
  configuredOptionsKey = key;
  return configuredOptions;
}

function sourceRoot() {
  if (configuredResourceRoot) return path.join(configuredResourceRoot, 'sidecars', 'openjarvis');
  if (process.resourcesPath && process.versions && process.versions.electron && !process.defaultApp) {
    return path.join(process.resourcesPath, 'sidecars', 'openjarvis');
  }
  return path.join(__dirname, '..', 'sidecars', 'openjarvis');
}

function runtimeRoot() {
  return configuredRuntimeRoot || path.join(os.homedir(), '.gemair', 'openjarvis');
}

function venvPython() {
  return process.platform === 'win32'
    ? path.join(runtimeRoot(), 'venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot(), 'venv', 'bin', 'python');
}

function bridgePath() { return path.join(sourceRoot(), 'gemair_bridge.py'); }
function configPath() { return path.join(runtimeRoot(), 'config.toml'); }

function safeEnvironment() {
  const allow = [
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
    'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY',
    'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
  ];
  const env = {};
  for (const key of allow) if (process.env[key] != null) env[key] = process.env[key];
  env.OPENJARVIS_HOME = runtimeRoot();
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  // OpenJarvis defaults these on; GemAir keeps all integration telemetry off.
  env.DO_NOT_TRACK = '1';
  return env;
}

function tomlString(value) {
  return JSON.stringify(String(value || '').replace(/[\0\r\n]/g, ' ').slice(0, 4000));
}

function loopbackMcpUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) return '';
    return parsed.toString();
  } catch { return ''; }
}

function writeCapabilityPolicy(mcpEnabled) {
  const grants = [
    { capability: 'network:fetch', pattern: '*' },
    { capability: 'memory:read', pattern: '*' },
    { capability: 'memory:write', pattern: '*' },
    ...(mcpEnabled ? [{ capability: 'tool:invoke', pattern: '*' }] : [])
  ];
  const agents = ['simple', 'orchestrator', 'native_react', 'operative', 'monitor_operative', 'deep_research']
    .map((agent_id) => ({ agent_id, grants, deny: ['file:write', 'code:execute', 'system:admin', 'channel:send'] }));
  const file = path.join(runtimeRoot(), 'capability-policy.json');
  fs.writeFileSync(file, JSON.stringify({ agents }, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function writeConfig(options = {}) {
  options = { ...configuredOptions, ...options };
  const engine = /^[A-Za-z0-9._-]{1,80}$/.test(String(options.engine || '')) ? String(options.engine) : 'ollama';
  const model = /^[A-Za-z0-9._:/-]{0,160}$/.test(String(options.model || '')) ? String(options.model || '') : '';
  const ollamaHost = String(options.ollamaHost || 'http://127.0.0.1:11434');
  let host = 'http://127.0.0.1:11434';
  try {
    const parsed = new URL(ollamaHost);
    if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) host = parsed.toString().replace(/\/$/, '');
  } catch {}
  const mcpUrl = options.mcpEnabled === true ? loopbackMcpUrl(options.mcpUrl) : '';
  const mcpEnabled = !!mcpUrl;
  const mcpServers = mcpEnabled ? JSON.stringify([{ name: 'gemair-local', url: mcpUrl }]) : '[]';
  fs.mkdirSync(runtimeRoot(), { recursive: true, mode: 0o700 });
  const policyPath = writeCapabilityPolicy(mcpEnabled);
  const text = [
    '# Generated by GemAir. Secrets are never written here.',
    '[engine]',
    `default = ${tomlString(engine)}`,
    '',
    '[engine.ollama]',
    `host = ${tomlString(host)}`,
    '',
    '[intelligence]',
    `default_model = ${tomlString(model)}`,
    'temperature = 0.6',
    'max_tokens = 3000',
    '',
    '[agent]',
    'default_agent = "orchestrator"',
    'max_turns = 10',
    'tools = "think,calculator,retrieval,memory_search,memory_store,web_search"',
    'context_from_memory = true',
    'default_system_prompt = "You are the OpenJarvis reasoning engine inside GemAir. Analyze deeply, verify assumptions, use tools only when authorized, and report uncertainty clearly."',
    '',
    '[tools.storage]',
    'default_backend = "sqlite"',
    `db_path = ${tomlString(path.join(runtimeRoot(), 'memory.db'))}`,
    '',
    '[tools.mcp]',
    `enabled = ${mcpEnabled ? 'true' : 'false'}`,
    `servers = ${tomlString(mcpServers)}`,
    '',
    '[telemetry]',
    'enabled = false',
    'gpu_metrics = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[security]',
    'enabled = true',
    'profile = "personal"',
    'scan_input = true',
    'scan_output = true',
    'mode = "redact"',
    'enforce_tool_confirmation = true',
    'ssrf_protection = true',
    'rate_limit_enabled = true',
    'rate_limit_rpm = 30',
    'rate_limit_burst = 5',
    'local_engine_bypass = false',
    'local_tool_bypass = false',
    '',
    '[security.capabilities]',
    'enabled = true',
    'default_deny = true',
    `policy_path = ${tomlString(policyPath)}`,
    '',
    '[sandbox]',
    'enabled = false',
    'runtime = "docker"',
    'image = "openjarvis-sandbox:latest"',
    'timeout = 300',
    'max_concurrent = 1',
    '',
    '[traces]',
    'enabled = true',
    `db_path = ${tomlString(path.join(runtimeRoot(), 'traces.db'))}`,
    '',
    '[skills]',
    'enabled = true',
    'auto_discover = true',
    'auto_sync = false',
    'sandbox_dangerous = true',
    ''
  ].join('\n');
  fs.writeFileSync(configPath(), text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(configPath(), 0o600); } catch {}
  return configPath();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.cancelable && installCancelled) {
      reject(Object.assign(new Error('OpenJarvis installation was cancelled.'), { code: 'OPENJARVIS_INSTALL_CANCELLED' }));
      return;
    }
    // spawn() fails with ENOENT for every command when cwd does not exist, and
    // the runtime root is only created during install(). Probes, status checks,
    // and pre-install checks must still work before that — none of them depend
    // on the working directory, so fall back to one that always exists.
    let cwd = options.cwd || runtimeRoot();
    if (!fs.existsSync(cwd)) cwd = os.tmpdir();
    const child = spawn(command, args, {
      cwd,
      env: options.env || safeEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (options.cancelable) installChild = child;
    let stdout = '';
    let stderr = '';
    const maxOutput = Number(options.maxOutput) || 512 * 1024;
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(Object.assign(new Error(`${options.label || 'process'} timed out`), { code: 'OPENJARVIS_PROCESS_TIMEOUT' }));
    }, Number(options.timeoutMs) || 30_000);
    const collect = (kind, chunk) => {
      const text = chunk.toString('utf8');
      if (kind === 'stdout') stdout = (stdout + text).slice(-maxOutput);
      else stderr = (stderr + text).slice(-maxOutput);
      if (options.onProgress) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) options.onProgress({ stage: options.label || 'process', line: line.slice(0, 500) });
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      if (installChild === child) installChild = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (installChild === child) installChild = null;
      if (options.cancelable && installCancelled) {
        reject(Object.assign(new Error('OpenJarvis installation was cancelled.'), { code: 'OPENJARVIS_INSTALL_CANCELLED' }));
      } else if (code === 0) resolve({ stdout, stderr, code: 0 });
      else {
        const detail = (stderr || stdout).trim().slice(-2000);
        reject(Object.assign(new Error(`${options.label || command} failed (${code == null ? signal : code})${detail ? ': ' + detail : ''}`), { code: 'OPENJARVIS_PROCESS_FAILED', exitCode: code }));
      }
    });
  });
}

function isSupportedPythonVersion(major, minor) {
  return Number(major) === 3 && Number(minor) >= 10 && Number(minor) < 14;
}

async function findPython(options = {}) {
  if (options.python) return options.python;
  const installed = venvPython();
  if (fs.existsSync(installed)) return installed;
  // `options.candidates` is a test seam (same [command, prefix] shape).
  // NOTE: `py -3` resolves to the NEWEST installed Python (3.14+ on many
  // machines), and some launchers list older runtimes without matching a
  // `-3.x` selector — so probe pinned minors explicitly AND bare
  // version-suffixed executables (python3.12 etc., common via uv installs).
  // A compatible 3.10–3.13 is often present alongside a newer default.
  const candidates = options.candidates || (process.platform === 'win32'
    ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3.10', []], ['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]]);
  for (const [command, prefix] of candidates) {
    try {
      const result = await run(command, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { timeoutMs: 5000, label: 'python probe' });
      const match = result.stdout.match(/(\d+)\.(\d+)/);
      if (match && isSupportedPythonVersion(match[1], match[2])) return { command, prefix };
    } catch {}
  }
  throw Object.assign(new Error('OpenJarvis requires Python 3.10–3.13.'), { code: 'OPENJARVIS_PYTHON_REQUIRED' });
}

function pythonCommand(value) {
  return typeof value === 'string' ? { command: value, prefix: [] } : value;
}

async function cargoAvailable() {
  try { await run('cargo', ['--version'], { timeoutMs: 5000, label: 'Rust probe' }); return true; }
  catch { return false; }
}

async function install(options = {}) {
  if (installPromise) return installPromise;
  installCancelled = false;
  installPromise = (async () => {
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    if (!fs.existsSync(path.join(sourceRoot(), 'pyproject.toml')) || !fs.existsSync(bridgePath())) throw new Error('OPENJARVIS_SOURCE_MISSING');
    fs.mkdirSync(runtimeRoot(), { recursive: true, mode: 0o700 });
    writeConfig(options);
    progress({ stage: 'prepare', line: 'Checking Python 3.10–3.13…' });
    const selected = pythonCommand(await findPython(options));
    if (!fs.existsSync(venvPython())) {
      progress({ stage: 'venv', line: 'Creating an isolated OpenJarvis environment…' });
      await run(selected.command, [...selected.prefix, '-m', 'venv', path.join(runtimeRoot(), 'venv')], { timeoutMs: 120_000, label: 'venv', onProgress: progress, cancelable: true });
    }
    progress({ stage: 'python', line: 'Installing the pinned OpenJarvis Python implementation…' });
    await run(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', sourceRoot()], {
      timeoutMs: Number(options.pythonTimeoutMs) || 20 * 60 * 1000,
      label: 'OpenJarvis Python',
      onProgress: progress,
      cancelable: true,
      maxOutput: 2 * 1024 * 1024
    });

    let rustInstalled = false;
    let rustMessage = '';
    if (await cargoAvailable()) {
      progress({ stage: 'rust', line: 'Building the pinned OpenJarvis Rust extension…' });
      try {
        await run(venvPython(), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', path.join(sourceRoot(), 'rust', 'crates', 'openjarvis-python')], {
          timeoutMs: Number(options.rustTimeoutMs) || 30 * 60 * 1000,
          label: 'OpenJarvis Rust',
          onProgress: progress,
          cancelable: true,
          maxOutput: 2 * 1024 * 1024
        });
        rustInstalled = true;
      } catch (error) {
        rustMessage = error.message;
      }
    } else {
      rustMessage = 'Rust toolchain not found. Python reasoning, policy, memory, and MCP remain available; install Rust 1.88+ and run setup again only for native acceleration.';
    }
    stop();
    const health = await start({ timeoutMs: 30_000 });
    return { ok: true, installed: true, rustInstalled: !!health.rustAvailable || rustInstalled, rustMessage, health };
  })().finally(() => { installPromise = null; installChild = null; installCancelled = false; });
  return installPromise;
}

function rejectPending(error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function handleProtocolData(chunk) {
  processBuffer += chunk.toString('utf8');
  if (Buffer.byteLength(processBuffer, 'utf8') > MAX_PROTOCOL_BUFFER) {
    const error = new Error('OPENJARVIS_PROTOCOL_OVERFLOW');
    lastError = error.message;
    stop();
    rejectPending(error);
    return;
  }
  const lines = processBuffer.split('\n');
  processBuffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === false) {
      const error = new Error(`OPENJARVIS_${message.error || 'FAILED'}: ${message.message || 'Request failed'}`);
      error.code = message.error || 'OPENJARVIS_FAILED';
      entry.reject(error);
    } else entry.resolve(message);
  }
}

/**
 * Build the error for a dead bridge process. A clean exit (code 0) is a
 * normal shutdown — trailing log noise (e.g. per-server MCP warnings) must
 * never be presented as the failure. Only abnormal exits carry detail.
 * Pure function — unit-tested.
 */
function bridgeExitError(code, signal, stderrTail) {
  if (code === 0) {
    const error = new Error('OPENJARVIS_BRIDGE_CLOSED: the helper process ended; retry the action.');
    error.code = 'OPENJARVIS_BRIDGE_CLOSED';
    return error;
  }
  const error = new Error(`OPENJARVIS_EXIT_${code == null ? signal : code}${stderrTail ? ': ' + String(stderrTail).slice(-1000) : ''}`);
  error.code = 'OPENJARVIS_EXIT';
  return error;
}

async function start(options = {}) {
  if (processHandle && processHandle.exitCode == null) return request('health', {}, { timeoutMs: options.timeoutMs || 15_000, skipStart: true });
  if (startPromise) return startPromise;
  startPromise = (async () => {
    if (!fs.existsSync(venvPython())) throw Object.assign(new Error('Install OpenJarvis from Settings before enabling deep reasoning.'), { code: 'OPENJARVIS_NOT_INSTALLED' });
    writeConfig(options);
    const child = spawn(venvPython(), ['-u', bridgePath()], {
      cwd: runtimeRoot(),
      env: safeEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    processHandle = child;
    processBuffer = '';
    let stderr = '';
    child.stdout.on('data', handleProtocolData);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    child.once('error', (error) => {
      lastError = error.message || String(error);
      if (processHandle === child) processHandle = null;
      rejectPending(error);
    });
    child.once('exit', (code, signal) => {
      const error = bridgeExitError(code, signal, stderr);
      lastError = error.message;
      if (processHandle === child) processHandle = null;
      rejectPending(error);
    });
    return request('health', {}, { timeoutMs: options.timeoutMs || 30_000, skipStart: true });
  })().finally(() => { startPromise = null; });
  return startPromise;
}

function request(op, payload = {}, options = {}) {
  const execute = async () => {
    if (!options.skipStart) await start(options.startOptions || {});
    if (!processHandle || processHandle.exitCode != null || !processHandle.stdin.writable) throw new Error('OPENJARVIS_NOT_RUNNING');
    const id = nextRequestId++;
    const body = JSON.stringify({ id, op, ...payload });
    if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('OPENJARVIS_REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`OPENJARVIS_${op.toUpperCase()}_TIMEOUT`), { code: 'OPENJARVIS_TIMEOUT' }));
      }, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      processHandle.stdin.write(body + '\n', (error) => {
        if (!error) return;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  };
  return execute();
}

function cancelInstall() {
  if (!installPromise) return { ok: false, installing: false };
  installCancelled = true;
  const child = installChild;
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    if (timer.unref) timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
  return { ok: true, installing: true };
}

function stop() {
  const child = processHandle;
  processHandle = null;
  processBuffer = '';
  if (!child) return;
  rejectPending(new Error('OPENJARVIS_STOPPED'));
  try { child.stdin.end(); } catch {}
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
  if (timer.unref) timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

async function status(options = {}) {
  let python = null;
  try {
    const found = pythonCommand(await findPython(options));
    python = found.command + (found.prefix.length ? ' ' + found.prefix.join(' ') : '');
  } catch {}
  const base = {
    sourceBundled: fs.existsSync(path.join(sourceRoot(), 'UPSTREAM_REVISION')),
    sourceRevision: OPENJARVIS_REVISION,
    installed: fs.existsSync(venvPython()),
    running: !!(processHandle && processHandle.exitCode == null),
    python,
    rustAvailable: false,
    telemetryEnabled: false,
    analyticsEnabled: false,
    lastError: lastError.slice(0, 500)
  };
  if (!base.installed) return base;
  try { return { ...base, ...(await start({ timeoutMs: 30_000 })) }; }
  catch (error) { lastError = error.message || String(error); return { ...base, lastError: lastError.slice(0, 500) }; }
}

module.exports = {
  OPENJARVIS_REVISION,
  bridgePath,
  bridgeExitError,
  cancelInstall,
  configure,
  configPath,
  findPython,
  install,
  isSupportedPythonVersion,
  request,
  runtimeRoot,
  setRuntimeOptions,
  sourceRoot,
  start,
  status,
  stop,
  venvPython,
  writeConfig
};
