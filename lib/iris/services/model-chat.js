"use strict";
/**
 * model-chat.js
 *
 * The chat client. Ported from `iris-windows/src/services/claude.ts`, with the
 * Anthropic Messages wire format swapped for OpenAI chat-completions — which is
 * what every OpenCode route speaks — and the metered/usage reporting removed
 * along with the metering.
 *
 * It never decides where a request goes or what credential it carries:
 * `assistant-transport.js` owns both. So this file reads as "what GemAir says
 * to the model", and nothing else.
 *
 * The pointing protocol below is upstream's, unchanged in substance: the reply
 * is plain text carrying `[POINT:x,y:label:screenN]` tags, which
 * `coordinates.js` parses and the overlay animates.
 */
Object.defineProperty(exports, "__esModule", { value: true });

const {
  AssistantTransportFailure,
  failureForStatusCode,
  makeChatRequest,
  shouldSendModelInRequestBody,
} = require("./assistant-transport");
const { assertFreeModelId } = require("./opencode-models");

/** At most 50 messages per request — upstream's protocol cap, kept. */
const MAX_MESSAGES_PER_REQUEST = 50;

/** The output ceiling for one chat turn. */
const MAX_TOKENS = 2048;
exports.MAX_TOKENS = MAX_TOKENS;

const SYSTEM_PROMPT = `You are Gem, GemAir's desktop companion. You can see the user's screen via screenshots (one per display) and read what they type.

## CRITICAL: Visual pointing protocol

You are NOT a regular chat assistant. Your defining feature is that you POINT at things on the user's screen with an animated cursor overlay. Whenever the user asks "where", "how do I", "show me", "click", "find", or otherwise asks for visual guidance, you MUST emit at least one POINT tag for every UI element you reference.

POINT tag format (embed inline in your text):
[POINT:x,y:label:screenN]

- **x,y MUST be in IMAGE pixel coordinates of the screenshot you see**, NOT the user's actual screen resolution. The "Screens:" list in the user message tells you the IMAGE dimensions for each screen — use those.
- x ranges from 0 (left edge of image) to imageWidth-1 (right edge)
- y ranges from 0 (top edge) to imageHeight-1 (bottom edge)
- label = a 2-5 word description of what you're pointing at
- screenN = the screen index from the "Screens:" list (screen0, screen1, ...)
- The system automatically scales your image coordinates to the user's actual screen pixels, so just use what you see.

## How to find accurate coordinates

Look at the screenshot carefully. For each UI element you want to point at:
1. Identify it visually
2. Estimate its center pixel in the image (image origin = top-left = 0,0)
3. Be precise — better to look twice than guess
4. Sanity-check: a button at the bottom of the screen should have a y close to imageHeight, not imageHeight/2

## Examples

User says: "How do I add this video to a playlist on YouTube?"
(Screens: screen0 image is 1568x882)
You: "Click 'Save' [POINT:920,820:Save button:screen0] below the video, then pick a playlist."

User says: "Where's the back button?"
(Screens: screen0 image is 1568x882)
You: "Here [POINT:30,75:Back arrow:screen0]."

## Multi-monitor

When the user has more than one screen, you receive one image per display (screen0, screen1, ...). Before you answer:

1. Scan ALL provided screenshots, not just screen0. The element the user is asking about may be on any of them.
2. If the user hints at a specific screen ("my other monitor", "on the left screen"), use that screen.
3. If no hint is given and the element appears on only one screen, use that screen.
4. If the element is visible on multiple screens, prefer the one where it's clearest/largest.
5. The screenN index in your POINT tag MUST match the screen where you actually found the element.

## Disambiguating visually similar elements

Many UI layouts contain rows or columns of visually similar elements (list rows, tabs, toolbar buttons, like/dislike pairs). When the user references one specific item in such a group:

1. Read the user's description carefully (title, position, adjacent text, icon type).
2. Match against the VISIBLE text or unique marker of each candidate — do NOT just pick the first or geometrically nearest one.
3. If the description is ambiguous, pick the one whose visible text matches most literally, and mention the chosen title so the user can confirm.
4. For vertical lists, double-check that your y coordinate lands on the intended ROW, not the one above or below.

## Rules

1. When the user asks visual/spatial questions, ALWAYS include POINT tags. Do not just describe — POINT.
2. Use IMAGE pixel coordinates (the dimensions given in the "Screens:" list).
3. One POINT tag per UI element you reference. Multiple steps → multiple tags.
4. Tags can appear inline anywhere in the text. The cursor overlay reads them and animates.
5. Be concise — short sentences, real-time conversation.
6. Match the user's language.
7. Only skip POINT tags if the user is asking a non-visual question.

## PRE-SEND CHECKLIST (verify before every response)

- [ ] Does my response mention a UI element the user should click, press, look at, find, or interact with?
- [ ] For each such element, is there a \`[POINT:x,y:label:screenN]\` tag in my message?
- [ ] Do the screenN values match the screen where I actually located each element?

**If the answer to 1 is YES and any tag is missing, REWRITE your response with the tags before sending.** A response that says "click the Y button" but contains zero POINT tags is a BUG.`;
exports.SYSTEM_PROMPT = SYSTEM_PROMPT;

const REFINEMENT_SYSTEM_PROMPT =
  "You are a precise UI pointing tool. You receive a zoomed crop of a screenshot and a description of a UI element. " +
  'Return ONLY "x,y" — integer pixel coordinates of the exact visual center of the element matching the description. ' +
  "CRITICAL: the crop may contain visually similar neighboring elements (e.g. a Like button next to a Dislike button, " +
  "or several tabs side by side). Return the EXACT element described, NOT an adjacent look-alike. " +
  "Aim for the center of the element's icon or main hit target. " +
  'If the element is not visible in the crop, return "none". No other text, no prose, no units.';
exports.REFINEMENT_SYSTEM_PROMPT = REFINEMENT_SYSTEM_PROMPT;

/** One image content part, in the format every OpenAI-compatible route takes. */
function imagePart(base64Jpeg) {
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } };
}
exports.imagePart = imagePart;

class ModelChatService {
  /**
   * @param {object} options
   * @param {object} options.transport  from `selectTransport`
   * @param {string} options.model      a FREE OpenCode model id
   * @param {Function} [options.fetchImplementation]
   * @param {object} [options.chatBackend]  a route that answers without HTTP (the CLI)
   */
  constructor(options) {
    this.transport = options.transport;
    // The gate runs here as well as in the request builder, so a service
    // constructed with a paid model fails before it is ever asked anything.
    this.model = assertFreeModelId(options.model);
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
    this.chatBackend = options.chatBackend;
  }

  async query(params) {
    const userContent = [];

    for (const screenshot of params.screenshots || []) {
      userContent.push(imagePart(screenshot.data));
    }

    userContent.push({
      type: "text",
      text: [
        `User says: "${params.userMessage}"`,
        `Cursor position: (${params.cursorPosition.x}, ${params.cursorPosition.y})`,
        "Screens (give POINT coordinates in IMAGE pixels — use the image dimensions below, NOT the actual screen resolution):",
        ...(params.screenshots || []).map(
          (screen, index) =>
            `  screen${index}: image is ${screen.imageDimensions.width}x${screen.imageDimensions.height} px ` +
            `(actual display ${screen.bounds.width}x${screen.bounds.height} at ${screen.bounds.x},${screen.bounds.y})`
        ),
      ].join("\n"),
    });

    const trimmedHistory = (params.conversationHistory || []).slice(-MAX_MESSAGES_PER_REQUEST);
    const messages = trimmedHistory.map((entry, index) => ({
      role: entry.role,
      content:
        index === trimmedHistory.length - 1 && entry.role === "user" ? userContent : entry.content,
    }));

    const systemContent = params.additionalSystemContext
      ? `${SYSTEM_PROMPT}\n\n${params.additionalSystemContext}`
      : SYSTEM_PROMPT;

    const responseText = await this.send({
      system: systemContent,
      messages,
      maxTokens: MAX_TOKENS,
    });
    return { text: responseText };
  }

  /**
   * Second-pass pointing refinement. Given a cropped patch and a label, ask the
   * model for the precise pixel center within that crop. Returns null if it
   * cannot find the element — the caller then keeps the first-pass estimate,
   * which is less precise but never wrong in a new way.
   */
  async refinePoint(options) {
    try {
      const responseText = await this.send({
        system: REFINEMENT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              imagePart(options.cropBase64),
              {
                type: "text",
                text:
                  `Crop image size: ${options.cropWidth}x${options.cropHeight} pixels (origin 0,0 = top-left).\n` +
                  `Target element: "${options.label}"\n` +
                  `Return the pixel center as "x,y" only.`,
              },
            ],
          },
        ],
        maxTokens: 32,
      });

      const match = responseText.match(/(\d+)\s*,\s*(\d+)/);
      if (!match) return null;
      return { x: Number.parseInt(match[1], 10), y: Number.parseInt(match[2], 10) };
    } catch {
      return null;
    }
  }

  /** The one place a request actually leaves. */
  async send(options) {
    // The CLI route runs a local binary rather than making an HTTP call, so it
    // is served by a backend rather than by a prepared request. Everything
    // above this line — the system prompt, the image parts, the POINT-tag
    // parsing, the refinement pass — is shared, which is what makes this
    // parity rather than a second client.
    if (this.chatBackend) {
      return this.chatBackend.respond({
        system: options.system,
        messages: options.messages,
        maxTokens: options.maxTokens,
        model: this.model,
      });
    }

    const preparedRequest = await makeChatRequest(this.transport);

    const body = {
      max_tokens: options.maxTokens,
      // OpenAI-compatible routes carry the system prompt as the first message
      // rather than as its own field.
      messages: [{ role: "system", content: options.system }, ...options.messages],
      stream: false,
    };
    if (shouldSendModelInRequestBody(this.transport)) {
      body.model = assertFreeModelId(this.model);
    }

    let response;
    try {
      response = await this.fetchImplementation(preparedRequest.url, {
        method: preparedRequest.method,
        headers: preparedRequest.headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new AssistantTransportFailure({
        kind: "transportFailure",
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const rawBody = await response.text();

    if (!response.ok) {
      throw new AssistantTransportFailure(
        failureForStatusCode({
          statusCode: response.status,
          rawBody,
          retryAfterHeaderValue: response.headers.get("Retry-After"),
          tier: this.transport.tier,
        })
      );
    }

    return readAssistantText(rawBody);
  }
}
exports.ModelChatService = ModelChatService;

/**
 * Reads the text out of a chat-completions body.
 *
 * Tolerant on purpose: Zen's models differ in whether they answer with a plain
 * `content` string, an array of parts, or a `reasoning_content` alongside it.
 * A reply GemAir cannot read is reported as a transport failure rather than
 * rendered as an empty bubble.
 */
function readAssistantText(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new AssistantTransportFailure({
      kind: "transportFailure",
      reason: "the assistant returned something GemAir could not read",
    });
  }

  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const message = choice?.message ?? choice?.delta ?? null;
  const content = message?.content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  // The OpenAI Responses shape, which some Zen ids answer with.
  if (typeof parsed?.output_text === "string") return parsed.output_text;
  if (Array.isArray(parsed?.output)) {
    return parsed.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}
exports.readAssistantText = readAssistantText;
