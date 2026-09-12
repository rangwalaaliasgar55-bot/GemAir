# FreeGPT35 compatibility sidecar

This directory is a separately licensed, modified integration of
[`missuo/FreeGPT35`](https://github.com/missuo/FreeGPT35) at revision
`3bf421eecee954a5361677ec225f61348684f6bc`.

- `upstream-app.js` and `upstream-package.json` preserve the reviewed upstream
  implementation for source/license compliance and comparison.
- `server.js` is GemAir's production sidecar. It keeps the original anonymous
  session, proof-of-work, ChatGPT conversation, cumulative-SSE, and
  OpenAI-compatible `/v1/chat/completions` behavior.
- Everything in this directory is governed by `LICENSE` (AGPL-3.0-only).
  GemAir's independently written MIT code remains under the repository's root
  license; this component runs as a separately spawned loopback service.

## Security changes from upstream

The original implementation set `rejectUnauthorized: false`, accepted requests
on all interfaces, allowed every browser origin, had no caller authentication,
and returned some failures with successful HTTP status codes. GemAir does not
preserve those unsafe details:

- TLS certificate verification is always enabled.
- The service binds to `127.0.0.1` on an ephemeral port.
- Every route requires a random bearer secret supplied over process IPC.
- CORS is not enabled.
- Request/message sizes and concurrency are bounded.
- Timeouts and upstream failures are explicit.
- The standard `[DONE]` SSE terminator is emitted.

These changes preserve the requested feature while preventing websites or
network peers from silently using the user's local sidecar.

## Reliability limitation

FreeGPT35 depends on undocumented anonymous ChatGPT endpoints and an old model
identifier. OpenAI may change or disable either at any time. GemAir reports that
failure and continues to its local/live-tools fallback; it never fabricates a
model response or disables TLS to make the request appear successful.
