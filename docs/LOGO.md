# GemAir Logo

## Mark

A hexagonal gem cut inscribed in a circular aperture.

- **Gem** — clarity, multi-facet intelligence, the “Gem” persona.
- **Ring** — open air / orbit; the “Air” half of the name; signals calm containment rather than sci-fi HUD chrome.
- **Geometry** — six facets + three cut lines remain legible at 16×16; gradients read as premium glass at 512+.

## Variants

| File | Use |
| --- | --- |
| `renderer/assets/logo-mark.svg` | Dark UI, app header, about |
| `renderer/assets/logo-mark-light.svg` | Light appearance header |
| `renderer/assets/logo-mark-mono.svg` | Single-color / badge / print (`currentColor`) |
| `renderer/favicon.svg` | Favicon (mark on dark rounded square) |

## Raster pipeline (S10)

`node scripts/generate-icons.js` regenerates every raster from `renderer/assets/logo-mark.svg` — no npm dependencies (Node's zlib + a small supersampling rasterizer):

- `build/icon.png` (1024) · `build/icon.ico` (PNG-in-ICO, 256) · `build/icons/{16,32,48,64,128,256,512,1024}`
- `renderer/assets/gemair-512.png` (PWA manifest)

Edit the SVG, run the script, commit. If the SVG gains new primitives, extend the parser in the script to match.

## Rationale

The previous mark was a photographic / heavy PNG that muddied at favicon size and leaned on neon glow. The new SVG is first-party, zero-dependency, and aligns with Apple-style product icons: simple silhouette, continuous corners on the favicon plate, restrained blue–indigo spectrum (system blue family) instead of rainbow cyberpunk.
