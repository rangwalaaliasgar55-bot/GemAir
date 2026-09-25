"use strict";
/**
 * opencode-cli.js
 *
 * Driving the reader's own `opencode` binary as a chat model. Ported from
 * `iris-windows/src/services/codex-chat.ts` — same job, same shape, a different
 * CLI: GemAir never asks anybody to sign into ChatGPT or Anthropic, and the
 * opencode CLI is free software the reader may already have pointed at free
 * models.
 *
 * Why this is possible at all: the companion chat sends NO tools. The body is a
 * system prompt, a conversation, and screenshots, and the reply is plain text
 * carrying `[POINT:x,y:label:screenN]` tags. `opencode run` takes one prompt and
 * prints a final message — which is exactly that shape.
 *
 * What is NOT equivalent, stated plainly rather than discovered later:
 *   - opencode is an agent. Its instinct on a task is to go and use its own
 *     shell and file tools, which here would produce an empty reply — its cwd
 *     is a scratch directory with nothing in it. The framing preamble below is
 *     what holds it to answering instead, and a preamble is a request, not a
 *     guarantee.
 *   - There is no system-prompt channel, so the system prompt is folded in as a
 *     leading block and the conversation is replayed under speaker labels.
 *   - Screenshots are handed over as `@path` mentions. Whether the reader's
 *     opencode build attaches them depends on the model it is configured with;
 *     a text-only model answers the prose and ignores the images.
 *
 * Pure: argv, prompt text, output parsing and error classification. Spawning
 * and temp files belong to `main/opencode-session.js`.
 */
Object.defineProperty(exports, "__esModule", { value: true });

/** The reader's own binary. Never a path GemAir constructs from input. */
const OPENCODE_EXECUTABLE = "opencode";
exports.OPENCODE_EXECUTABLE = OPENCODE_EXECUTABLE;

/**
 * Flag prefixes GemAir must never pass. A prompt is attacker-influenced text (a
 * guide, a web page, a screenshot's contents), so the allowlist is enforced on
 * the argv GemAir builds, not merely intended.
 */
const FORBIDDEN_FLAG_PREFIXES = Object.freeze([
  "--dangerously",
  "--yolo",
  "--permission",
  "--allow",
  "--config",
  "-c",
]);

class OpenCodeArgumentError extends Error {}
exports.OpenCodeArgumentError = OpenCodeArgumentError;

/**
 * One `opencode run` invocation.
 *
 * The prompt itself is passed on stdin (see `main/opencode-session.js`), so the
 * argv carries only flags — a screenshot-laden conversation is far past any
 * Windows command-line length limit, and a prompt on the command line is
 * visible to every other process in the process list.
 */
function buildOpenCodeChatArguments(options = {}) {
  const args = ["run"];

  if (options.model) {
    if (String(options.model).startsWith("-")) {
      throw new OpenCodeArgumentError("a model name may not look like a flag");
    }
    args.push("--model", String(options.model));
  }

  // A read-only agent where the build supports one: GemAir is asking a
  // question, not asking opencode to change the reader's machine.
  if (options.agent) {
    if (String(options.agent).startsWith("-")) {
      throw new OpenCodeArgumentError("an agent name may not look like a flag");
    }
    args.push("--agent", String(options.agent));
  }

  for (const argument of args) {
    for (const forbidden of FORBIDDEN_FLAG_PREFIXES) {
      if (argument === forbidden || argument.startsWith(`${forbidden}=`)) {
        throw new OpenCodeArgumentError(`refusing to pass ${argument} to opencode`);
      }
    }
  }

  return args;
}
exports.buildOpenCodeChatArguments = buildOpenCodeChatArguments;

/** Tells opencode it is being used as a text model, not turned loose on a repo. */
const OPENCODE_FRAMING_PREAMBLE = `You are being used as a text model inside another program. Do not use YOUR OWN shell, file, edit, or search tools — the directory you are running in is an empty scratch directory with nothing relevant in it, so any attempt will silently fail. Your entire reply is the deliverable.

Answer as the assistant described below, following its output format exactly. Reply with the answer itself and nothing else: no preamble, no explanation of what you are about to do, no summary of what you did.`;
exports.OPENCODE_FRAMING_PREAMBLE = OPENCODE_FRAMING_PREAMBLE;

/**
 * Folds the system prompt and the conversation into the one prompt `opencode
 * run` accepts.
 *
 * Speaker labels rather than a transcript format opencode might try to
 * continue: the last line is always the live question, so the model is
 * answering rather than predicting the next turn of a document.
 */
function foldConversationIntoOnePrompt(options) {
  const sections = [
    OPENCODE_FRAMING_PREAMBLE,
    "",
    "--- ASSISTANT INSTRUCTIONS ---",
    options.system,
  ];

  const imagePaths = options.imagePaths || [];
  if (imagePaths.length > 0) {
    sections.push(
      "",
      "--- SCREENS ---",
      imagePaths.length === 1
        ? `One screenshot is attached: it is screen 1. ${mention(imagePaths[0])}`
        : `${imagePaths.length} screenshots are attached, in order, screen 1 through screen ${imagePaths.length}: ` +
            imagePaths.map(mention).join(" ")
    );
  }

  sections.push("", "--- CONVERSATION ---");
  for (const message of options.messages || []) {
    sections.push(`${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}`);
  }
  sections.push("", "Reply as the assistant, to the final User turn.");

  return sections.join("\n");
}
exports.foldConversationIntoOnePrompt = foldConversationIntoOnePrompt;

/** opencode reads `@path` as "attach this file". */
function mention(filePath) {
  return `@${filePath}`;
}

/**
 * opencode writes progress and tool lines to stdout alongside the answer. The
 * answer is what is left once the log furniture is dropped: timestamped lines,
 * the box-drawing banner it prints on start, and its `|` -prefixed tool rows.
 */
function extractFinalMessage(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  const withoutLogLines = lines.filter((line) => {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?\s/.test(line)) return false;
    if (/^\s*[│┌└├─┐┘]/.test(line)) return false;
    if (/^\s*\|\s/.test(line)) return false;
    if (/^\s*(INFO|DEBUG|WARN|ERROR)\s/.test(line)) return false;
    return true;
  });
  return withoutLogLines.join("\n").trim();
}
exports.extractFinalMessage = extractFinalMessage;

/**
 * Classifies a finished run. Quotes opencode when GemAir does not recognise the
 * failure, because a passed-through sentence from the tool the reader already
 * uses beats GemAir inventing a diagnosis.
 */
function classifyOpenCodeFailure(options) {
  if (options.spawnFailed) return { kind: "notInstalled" };

  const combined = `${options.stderr || ""}\n${options.stdout || ""}`.toLowerCase();

  if (options.exitCode === 0) {
    return extractFinalMessage(options.stdout).length === 0 ? { kind: "emptyReply" } : null;
  }

  if (
    combined.includes("opencode auth login") ||
    combined.includes("no provider") ||
    combined.includes("not authenticated") ||
    combined.includes("missing api key")
  ) {
    return { kind: "noProvider" };
  }

  if (combined.includes("unknown option") || combined.includes("usage: opencode")) {
    return { kind: "argumentMismatch", detail: firstUsefulLine(options.stderr) };
  }

  return {
    kind: "failed",
    exitCode: options.exitCode,
    detail: firstUsefulLine(options.stderr) || firstUsefulLine(options.stdout),
  };
}
exports.classifyOpenCodeFailure = classifyOpenCodeFailure;

function firstUsefulLine(text) {
  return (
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^\d{4}-\d{2}-\d{2}T/.test(line)) ?? ""
  );
}

/** What the reader is told, in the assistant's own lowercase voice. */
function openCodeFailureMessage(failure) {
  switch (failure.kind) {
    case "notInstalled":
      return "i couldn't find the opencode command. install it with `npm install -g opencode-ai`, then pick a free model with `opencode models`.";
    case "noProvider":
      return "your opencode cli has no model configured. run `opencode auth login`, choose opencode zen, and pick a free model — or just let me use opencode zen directly in settings.";
    case "argumentMismatch":
      return `your opencode cli wouldn't accept how gemair called it, so the two are out of step. update it (\`npm install -g opencode-ai@latest\`), or switch to opencode zen in settings.${failure.detail ? ` opencode said: ${failure.detail}` : ""}`;
    case "emptyReply":
      return "opencode finished without answering. that usually means it tried to go and do the task instead of replying — ask again, or switch provider in settings.";
    case "failed":
      return `opencode couldn't finish that.${failure.detail ? ` it said: ${failure.detail}` : ""}`;
    default:
      return "opencode couldn't finish that.";
  }
}
exports.openCodeFailureMessage = openCodeFailureMessage;
