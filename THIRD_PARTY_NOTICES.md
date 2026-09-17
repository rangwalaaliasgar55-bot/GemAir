# Third-party notices

GemAir includes the following third-party software in packaged desktop builds.

## `@opencoredev/loginwithchatgpt-core` 0.2.0

- Project: <https://github.com/opencoredev/login-with-chatgpt>
- Copyright: Copyright (c) 2026 Leo
- License: MIT

```text
MIT License

Copyright (c) 2026 Leo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## FreeGPT35-derived sidecar

- Project: <https://github.com/missuo/FreeGPT35>
- Revision: `3bf421eecee954a5361677ec225f61348684f6bc`
- License: GNU Affero General Public License v3.0 only
- Shipped source: [`sidecars/freegpt35/`](sidecars/freegpt35/)
- Full license: [`sidecars/freegpt35/LICENSE`](sidecars/freegpt35/LICENSE)

GemAir's production anonymous-chat sidecar is derived from FreeGPT35. It is a
separately licensed child program and remains AGPL-3.0-only; it is not
relicensed under GemAir's MIT license. The complete corresponding sidecar
source, upstream snapshot, provenance, modifications, and license are included
in the paths above. Network operators who modify this sidecar must comply with
the AGPL source-offer requirements.

## OpenJarvis Python/Rust sidecar

- Project: <https://github.com/open-jarvis/OpenJarvis>
- Revision: `b1055c983b25b298c7e97723847d215df18de4a8`
- License: Apache License 2.0
- Shipped source: [`sidecars/openjarvis/`](sidecars/openjarvis/)
- Full license: [`sidecars/openjarvis/LICENSE`](sidecars/openjarvis/LICENSE)

GemAir includes the reviewed OpenJarvis Python source and Rust workspace for an
explicitly installed, app-private reasoning runtime. GemAir-specific bridge and
lifecycle code is identified separately in source. OpenJarvis retains its
Apache-2.0 notices, attribution, and license.

## Reviewed but not included

GemAir's design review also studied `isair/jarvis` at revision
`d22ed8b975792842dc09e49861f31a39cbb302a6`. Its custom non-commercial license
is incompatible with GemAir's general MIT distribution, so no source, prompts,
assets, or tests from that project are included. See
[`docs/UPSTREAM-INTEGRATION.md`](docs/UPSTREAM-INTEGRATION.md) for the detailed
architecture and license review.

## Concept-shaped features — FatihMakes/Mark series (no source included)

GemAir 2.x reimplemented, on its own engine and with its own code, product
concepts documented by the Mark assistant series
(<https://github.com/FatihMakes/Mark-LIV> and the sibling Mark-LI–LIII
releases): the local "Hey Jarvis"-style wake word with auto-sleep, background
topic monitors with once-a-day only-on-change alerts, flight/game update
helpers (2.x Mark-LIII ports), and — in 2.12 — the long-horizon live voice
loop (session resumption + sliding-window compression + interruption), fused
screen/camera frames in the voice conversation, single-file drop-in skills,
consumed-once session memory, proactive time/context-aware check-ins,
Unicode-reduced viseme lip-sync, OS-aware first-run setup, and local-first
privacy hardening (git-tracked secret guard + revoke-and-rotate
documentation). The 2.13 wave added concept ports of Mark's accountability
features (shared undo stack, clipboard intelligence, push-to-talk, self-echo
guard, runtime self-knowledge, instant acknowledgement, launch-at-login,
plus transcript de-dup / resumption-handle hardening from its own fix list),
and 2.14 completed the set with an honest audio-device picker with probing,
gaze/presence behaviour for the avatar (look away while thinking, meet the
eyes while listening, lids falling while asleep), and source-labelled vision
frames so screen captures are never confused with photos of the user.

The Mark series is licensed Creative Commons BY-NC 4.0 (personal,
non-commercial use). **No Mark source code, prompts, assets, or tests are
included in GemAir** — every behavior above is an original implementation
against GemAir's own tool-calling engine, memory store, permission gates and
Gemini Live transport, released under GemAir's MIT license.
