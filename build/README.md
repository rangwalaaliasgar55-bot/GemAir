# GemAir application icons

These assets are generated from `renderer/assets/gemair-logo.png`.

- `icon.ico`: Windows multi-image icon (16–256 px)
- `icon.png`: 1024 px square master used by macOS packaging
- `icon.iconset/`: canonical macOS 1×/2× iconset (16–1024 px)
- `icons/`: Linux freedesktop PNG sizes (16–1024 px)

The square master crops the logo to its diamond/HUD mark so it remains legible at taskbar and dock sizes. `package.json` points each `electron-builder` target at its platform-appropriate asset.
