"use strict";
/**
 * opencode-session.js
 *
 * Runs the reader's own `opencode` binary and hands its answer back as a chat
 * reply. Ported from `iris-windows/src/main/codex-session.ts`.
 *
 * Every decision lives in `services/opencode-cli.js`; this file owns the things
 * a unit test cannot have — spawning a process, putting screenshots on disk
 * where an `@path` mention can reach them, and probing whether the binary
 * exists at all.
 *
 * GemAir stores no model credential for this route. The CLI owns whatever the
 * reader signed it into, which is the whole reason this route exists.
 */
Object.defineProperty(exports, "__esModule", { value: true });

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssistantTransportFailure } = require("../services/assistant-transport");
const {
  OPENCODE_EXECUTABLE,
  buildOpenCodeChatArguments,
  classifyOpenCodeFailure,
  extractFinalMessage,
  foldConversationIntoOnePrompt,
  openCodeFailureMessage,
} = require("../services/opencode-cli");

/** A local agent is markedly slower than an API call; this is a ceiling, not a target. */
const OPENCODE_TIMEOUT_MS = 180000;

/** Enough for a screenshot-bearing prompt without inviting an unbounded read. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Pulls the screenshots and the prose apart. The chat client builds OpenAI
 * content parts, which carry images inline as data URLs; the CLI wants file
 * paths, so the images are written out and the text is what goes into the
 * folded prompt.
 */
function splitContent(content) {
  if (typeof content === "string") return { text: content, imagesBase64: [] };
  if (!Array.isArray(content)) return { text: "", imagesBase64: [] };

  const textParts = [];
  const imagesBase64 = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
    if (block.type === "image_url" && typeof block.image_url?.url === "string") {
      const match = block.image_url.url.match(/^data:image\/[a-z.+-]+;base64,(.+)$/i);
      if (match) imagesBase64.push(match[1]);
    }
    // Upstream's Anthropic-shaped block, still accepted so a caller ported from
    // Iris keeps working.
    if (block.type === "image" && typeof block.source?.data === "string") {
      imagesBase64.push(block.source.data);
    }
  }
  return { text: textParts.join("\n"), imagesBase64 };
}
exports.splitContent = splitContent;

class OpenCodeChatBackend {
  constructor(options = {}) {
    /** A free model id to pin, or null to use whatever the CLI is configured with. */
    this.model = options.model || null;
  }

  async respond(request) {
    const conversation = [];
    const imagesBase64 = [];

    for (const message of request.messages || []) {
      const { text, imagesBase64: messageImages } = splitContent(message.content);
      imagesBase64.push(...messageImages);
      if (text.length > 0) {
        conversation.push({ role: message.role === "assistant" ? "assistant" : "user", text });
      }
    }

    const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gemair-opencode-"));
    try {
      const imagePaths = imagesBase64.map((base64, index) => {
        const imagePath = path.join(scratchDirectory, `screen-${index + 1}.jpg`);
        fs.writeFileSync(imagePath, Buffer.from(base64, "base64"));
        return imagePath;
      });

      const prompt = foldConversationIntoOnePrompt({
        system: request.system,
        messages: conversation,
        imagePaths,
      });

      const result = await this.runOpenCode(
        buildOpenCodeChatArguments({ model: this.model || request.model || null }),
        prompt,
        scratchDirectory
      );

      const failure = classifyOpenCodeFailure({
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        spawnFailed: result.spawnFailed,
      });
      if (failure) {
        throw new AssistantTransportFailure({
          kind: "cliUnavailable",
          reason: openCodeFailureMessage(failure),
        });
      }

      return extractFinalMessage(result.stdout);
    } finally {
      // The screenshots are the reader's screen. They do not outlive the call.
      fs.rmSync(scratchDirectory, { recursive: true, force: true });
    }
  }

  /**
   * The prompt goes in on stdin rather than as an argument: a screenshot-laden
   * conversation is far past any Windows command-line length limit, and a
   * prompt on the command line would also be visible to every other process on
   * the machine in the process list.
   */
  runOpenCode(args, prompt, workingDirectory) {
    return new Promise((resolve) => {
      const child = execFile(
        OPENCODE_EXECUTABLE,
        args,
        {
          cwd: workingDirectory,
          timeout: OPENCODE_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          shell: process.platform === "win32",
        },
        (error, stdout, stderr) => {
          const spawnFailed = Boolean(error && error.code === "ENOENT");
          const exitCode =
            error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "", spawnFailed });
        }
      );
      child.stdin?.end(prompt);
    });
  }
}
exports.OpenCodeChatBackend = OpenCodeChatBackend;

/**
 * Whether the reader has an `opencode` binary at all.
 *
 * Probed rather than assumed, and cached for a minute: the answer decides
 * whether settings offers the CLI route, and shelling out on every render of a
 * settings panel is not free.
 */
let cachedProbe = { at: 0, available: false };
const PROBE_TTL_MS = 60000;

function openCodeIsAvailable() {
  const now = Date.now();
  if (now - cachedProbe.at < PROBE_TTL_MS) return cachedProbe.available;
  cachedProbe = { at: now, available: probeOnce() };
  return cachedProbe.available;
}
exports.openCodeIsAvailable = openCodeIsAvailable;

function probeOnce() {
  try {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(OPENCODE_EXECUTABLE, ["--version"], {
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === "win32",
      encoding: "utf8",
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/** Forces the next `openCodeIsAvailable()` to re-probe. */
function invalidateOpenCodeProbe() {
  cachedProbe = { at: 0, available: false };
}
exports.invalidateOpenCodeProbe = invalidateOpenCodeProbe;

/**
 * Whether a local `opencode serve` is listening, and where.
 *
 * Returns a loopback base URL or null. The port is the one `opencode serve`
 * defaults to, overridable by the caller for a reader who moved it.
 */
async function probeLocalOpenCodeServer(port = 4096, fetchImplementation = globalThis.fetch) {
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    const response = await fetchImplementation(`${baseUrl}/models`, { method: "GET" });
    if (response && response.ok) return baseUrl;
  } catch {
    // Not running. That is a normal state, not an error.
  }
  return null;
}
exports.probeLocalOpenCodeServer = probeLocalOpenCodeServer;
