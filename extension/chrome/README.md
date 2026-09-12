# Gem Air Browser Link

Chrome/Edge MV3 extension. It is the only component that can see the active tab's URL
and stop a navigation inside the browser — a desktop app cannot do this on its own.

## Install (unpacked)
1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. In Gem Air: **Settings → Browser → Generate pairing code**.
3. Click the extension icon, enter the 6-digit code, press **Pair**.

## What it does
- Reports `{url, title}` of the active tab to `127.0.0.1:8677/tab` (loopback only, token-guarded).
- Pulls block policy from `/policy` every 15s.
- Replaces navigations to blocked sites with the local block page and posts the attempt to `/attempt`.

## What it does not do
- No data leaves the machine. No remote endpoints. If the desktop app is closed the
  extension fails open and browsing is unaffected.
