# Download GemAir

## Installers (GitHub Releases)

After a version tag is pushed (`v2.5.1`, etc.), GitHub Actions builds:

| Platform | Artifact |
|----------|----------|
| Windows | `GemAir Setup *.exe` (NSIS) |
| macOS | `GemAir-*.dmg` / `.zip` |
| Linux | `GemAir-*.AppImage` / `.deb` |

**Latest release:** https://github.com/rangwalaaliasgar55-bot/GemAir/releases/latest  

**Landing page:** `download.html` in the repo (or GitHub Pages).

## Publish a build

```bash
npm ci
npm run dist:win    # or dist:mac / dist:linux
# outputs in release/

git tag v2.5.1
git push origin v2.5.1
```

## From source

```bash
git clone https://github.com/rangwalaaliasgar55-bot/GemAir.git
cd GemAir && npm install && npm start
```

## Stonic-inspired skin

```bash
node scripts/apply_stonic_skin.js
```
