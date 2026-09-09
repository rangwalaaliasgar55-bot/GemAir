# GemAir Design Tokens Reference

Source file: `renderer/design-tokens.css`  
Loaded first in the CSS cascade (before `style.css`).

## Color (semantic)

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--color-bg-primary` | `#0b0c0f` | `#f2f3f7` | App canvas |
| `--color-bg-secondary` | `#12141a` | `#e8eaef` | Nested wells |
| `--color-surface-primary` | glass 72% | white 78% | Cards / panels |
| `--color-surface-elevated` | glass 88% | white 92% | Floating sheets |
| `--color-label-primary` | `#f5f5f7` | `#1d1d1f` | Primary text |
| `--color-label-secondary` | 60% white | 64% black | Secondary text |
| `--color-separator` | white 10% | ink 12% | Hairlines |
| `--color-system-blue` | `#0a84ff` | `#007aff` | Primary actions |
| `--color-system-green` | `#30d158` | `#34c759` | Success / online |
| `--color-system-orange` | `#ff9f0a` | `#ff9500` | Warning / busy |
| `--color-system-red` | `#ff453a` | `#ff3b30` | Danger / offline |

Legacy bridges (still set by `themes.js` on apply): `--bg`, `--bg-2`, `--panel`, `--panel-border`, `--text`, `--text-dim`, `--accent*`, `--good`, `--warn`, `--error`, `--info`.

## Materials (Liquid Glass)

| Tier | Blur | Saturate | Typical use |
| --- | --- | --- | --- |
| `--material-thin` | 16px | 140% | Chips, menu items |
| `--material-regular` | 28px | 160% | Cards, sidebars, top bar |
| `--material-thick` | 40px | 180% | Modals, sheets |
| `--material-ultra` | 48px | 180% | Control Center, dock |

Each tier exposes `-bg`, `-border`, `-highlight`. Utility classes: `.material-thin|regular|thick|ultra`.  
`@supports not (backdrop-filter)` falls back to opaque surfaces.

## Radius

`4 / 8 / 12 / 16 / 20 / 28` → `--radius-xs` … `--radius-2xl`, plus `--radius-full`.  
Continuous-corner aliases: `--radius-continuous`, `-lg`, `-xl` (CSS approximation of squircles).

## Elevation

| Token | Character |
| --- | --- |
| `--elevation-0` | flat |
| `--elevation-1` | resting control |
| `--elevation-2` | card |
| `--elevation-3` | popover |
| `--elevation-4` | sheet / modal |
| `--elevation-specular` | top-edge glass highlight |

## Typography

Stack: SF Pro Display/Text → system-ui → Segoe UI.  
Mono: SF Mono → JetBrains Mono → Menlo.  
Scale utilities: `.type-large-title` … `.type-caption` (Large Title → Caption 2).

## Motion

| Class | Duration | Curve |
| --- | --- | --- |
| press | 80ms | standard |
| control | 160ms | standard |
| panel | 240ms | emphasized |
| list | 240ms | decelerate |
| sheet | 420ms | spring |

`prefers-reduced-motion: reduce` zeroes all motion tokens.

## Spacing

4pt base: `--space-1` (4) … `--space-16` (64).

## Window controls

Original (non-trademark) chrome dots: `--win-close`, `--win-min`, `--win-max` — slightly desaturated vs Apple’s exact traffic lights; used by the custom title bar only as decorative affordances (not OS window buttons).
