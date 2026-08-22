# GemAir — Access From Anywhere

Three tiers of remote access, from zero-setup to full desktop control. All of
them keep your data local-first and your keys where they belong.

---

## 1. Hosted web — anywhere, any device (recommended)

The web build (`renderer/` static + `api/` serverless) is a **full GemAir**:
chat, voice, memory, tools, themes. Since **2.5 it is a PWA**, so once opened
in a browser it installs as a real app on phones, tablets and laptops.

```bash
npm i -g vercel
vercel            # deploys renderer/ + api/ with vercel.json settings
vercel --prod     # your permanent URL, e.g. https://gemair.vercel.app
```

Then on any device:

1. Open the URL in Chrome / Safari / Edge.
2. Tap **Install app** (or Share → Add to Home Screen).
3. GemAir launches full-screen, works offline for the UI shell, and syncs
   memory through Supabase when you configure it (see below).

**Make it yours:** set `ALLOWED_ORIGINS` to your custom domain if you use one,
and add free provider keys (`GROQ_API_KEY`, etc.) as Vercel environment
variables so every device gets real LLM replies with zero configuration.

### Cross-device memory

Add `SUPABASE_URL` + `SUPABASE_ANON_KEY` and enable anonymous sign-ins.
Every device's facts, notes, todos, goals, mood and action log mirror to your
own Supabase project with row-level security — phone picks up where the
laptop left off.

---

## 2. Same Wi-Fi — reach the dev server from any device

```bash
npm run serve
```

The dev server binds `0.0.0.0` and prints its network URLs:

```
→ local:   http://localhost:3000
→ network: http://192.168.1.23:3000   ← open on your phone/tablet
```

Anything on your Wi-Fi can now chat, run web tools and speak to Gem. This is
the fastest way to test voice + PWA install before deploying.

---

## 3. Your desktop install — over the internet

The Electron app controls *your* machine, so remote access means reaching the
machine it runs on. Two clean options:

### Option A — Tailscale (easiest, private mesh VPN)
1. Install Tailscale on the PC running GemAir **and** the device you'll use.
2. Sign in with the same account on both.
3. From anywhere, open `http://<pc-name>:3000` after starting `npm run serve`
   on the PC — or screen-share into the real desktop app.
4. Nothing is exposed publicly; traffic is end-to-end encrypted on your own
   tailnet. Free tier covers personal use.

### Option B — Cloudflare Tunnel (public URL, no port-forwarding)
```bash
cloudflared tunnel --url http://localhost:3000
```
Gives you a temporary `https://…trycloudflare.com` URL (or a named tunnel on
your own domain) that proxies to the machine running GemAir. Pair it with an
`ALLOWED_ORIGINS` entry for that hostname so the API guard accepts it.

> **Safety note:** option B exposes your instance to the internet behind only
> the origin allow-list and rate limits. Prefer Tailscale for anything that
> can touch your real files and shell tools.

---

## 4. Scale notes for the hosted build

| Concern | Default | With config |
|---|---|---|
| Daily fair-use cap | per-instance counters (reset on cold start) | shared across instances via `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV / Upstash REST) |
| Burst throttle (12/min/IP) | per-instance sliding window | shared 1-minute buckets via the same KV vars |
| Provider keys | server env vars only — never sent to browsers | same |

The KV integration is plain `fetch` against the REST endpoint — no SDK, and
any failure degrades silently to per-instance counting. Users never see an
error from the limiter; hitting caps returns friendly replies either way.
