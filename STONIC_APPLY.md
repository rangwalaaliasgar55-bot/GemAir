# Apply deeper Stonic wiring in GemAir

GemAir already has themes, Agent Town, System Core, voice, desktop tools, Connections UI.

## 1. Pull

```bash
git pull origin main
```

## 2. Register OAuth PKCE IPC (once)

```bash
node scripts/apply_oauth_ipc.js
node scripts/apply_oauth_preload.js
```

## 3. Use from renderer (Connections panel)

```js
const status = await window.gemair.connectionsOauthChatGPT();
// Gemini: export GEMAIR_GEMINI_CLIENT_ID before launch
const status2 = await window.gemair.connectionsOauthGemini();
```

Existing `connectionsOpenChatGPT` / `connectionsCaptureChatGPT` remain for embedded-session capture.

## 4. Priority (Stonic-like)

ChatGPT account → Gemini account → Free Core  
`connectionsSetPriority('chatgpt'|'gemini'|'free')`

## 5. Parity checklist

| Feature | GemAir |
|---------|--------|
| Themes full recolour | themes.js |
| Agent Town | in app |
| System Core | in app |
| Voice | Edge TTS |
| Desktop acts | tools + missions |
| ChatGPT / Gemini login | connections + OAuth PKCE |
| Free core | serverless |

Not cloned: Stonic paid binary, exact marketing UI, piracy.
