/* renderer/echo-guard.js — never answer Gem's own echo.
 *
 * Concept port (no upstream code) of Mark-LIV's self-echo guard: after Gem
 * finishes speaking, its own last sentence is still "in the room" through
 * the speakers and gets picked up by the microphone. The guard recognises
 * the tail of Gem's own voice inside freshly recognized text and drops it —
 * WITHOUT muting you, so interrupting the instant Gem stops still works.
 *
 * We do this at the transcript level (the robust half of Mark's
 * band-energy subtraction, portable to every STT path we ship):
 *   - if the recognized text is (a chunk of) something Gem just said → drop
 *   - if it STARTS with the tail of Gem's sentence and continues in your
 *     voice → strip the echo, keep the continuation
 *
 * Plain script, no deps. Exposed as window.GemEchoGuard + used by app.js;
 * scripts/echo-guard-test.js loads it in vm for unit tests.
 */
(function () {
  'use strict';

  const RECENT_WINDOW_MS = 8000;   // an echo older than 8 s is just… a sentence
  const MIN_ECHO_CHUNK = 4;        // chars; shorter overlaps are coincidence
  const MIN_REMAINDER = 2;         // chars of "your voice" worth keeping

  /** normalize for comparison: lowercase, strip diacritics+punct, squash space */
  function normalize(text) {
    return String(text || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9à-ÿа-яё\u0100-\u017F\u0370-\u03FF ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function createEchoGuard() {
    const recent = []; // { text, raw, spokenAt }

    /** Register something Gem just said (while or right after speaking). */
    function noteSpoken(text, when) {
      const clean = normalize(text);
      if (!clean) return;
      recent.push({ text: clean, spokenAt: when || Date.now() });
      while (recent.length > 12) recent.shift();
    }

    function pruneOld(now) {
      while (recent.length && now - recent[0].spokenAt > RECENT_WINDOW_MS) recent.shift();
    }

    /**
     * Inspect newly recognized user speech.
     * Returns { text, dropped, echoMatched, remainder }:
     *   - dropped=true  → nothing of yours here; caller should ignore it
     *   - remainder     → text after stripping an echo PREFIX (may be '')
     */
    function inspect(recognized, nowArg) {
      const now = nowArg || Date.now();
      pruneOld(now);
      const clean = normalize(recognized);
      if (!clean) return { text: recognized, dropped: false, echoMatched: false };

      for (let i = recent.length - 1; i >= 0; i--) {
        const said = recent[i].text;
        // 1) exact/substring echo of Gem's own line
        if (said === clean || (clean.length >= MIN_ECHO_CHUNK && said.includes(clean)) ||
            (said.length >= MIN_ECHO_CHUNK && clean.includes(said))) {
          return { text: '', dropped: true, echoMatched: true, matched: said };
        }
        // 2) echo PREFIX + your continuation: "…at 3 pm pm what about friday"
        for (let cut = Math.min(said.length, clean.length - MIN_REMAINDER); cut >= MIN_ECHO_CHUNK; cut--) {
          const tail = said.slice(-cut);
          if (clean.startsWith(tail)) {
            const rest = clean.slice(cut).trim();
            if (rest.length >= MIN_REMAINDER) {
              return { text: rest, dropped: false, echoMatched: true, remainder: rest, matched: tail };
            }
            return { text: '', dropped: true, echoMatched: true, matched: tail };
          }
        }
      }
      return { text: recognized, dropped: false, echoMatched: false };
    }

    return { noteSpoken, inspect, normalize, size: () => recent.length, clear: () => { recent.length = 0; } };
  }

  const api = { createEchoGuard, normalize, RECENT_WINDOW_MS, MIN_ECHO_CHUNK };
  if (typeof window !== 'undefined') window.GemEchoGuard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
