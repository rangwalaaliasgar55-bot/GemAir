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

## Accent bridges

`--accent`, `--accent-soft`, `--accent-glow`, `--accent-dim` default to calm system blue (dark `#0a84ff`, light `#007aff`). `themes.js` overwrites them on `<body>` when a HUD theme applies, so accents recolor small strokes and data viz only — never the chrome.

## Component recipes — `renderer/components.css`

Purely additive `.ga-*` classes, token-driven, documented in the file header. Legacy mapping:

| Recipe | Legacy class it replaces |
| --- | --- |
| `.ga-card` | `.hud-panel` |
| `.ga-section-title` | `.panel-title` |
| `.ga-row` (+ `-icon/-main/-title/-sub/-value/-chevron`) | new (Settings list rows) |
| `.ga-btn-primary / -secondary / -ghost / -destructive` | `.primary-btn` / `.ghost-btn` / `.mini-btn` |
| `.ga-icon-btn` (`.is-round`) | `.icon-btn` |
| `.ga-segmented > button.active` | `.core-tabs` / `.sat-tabs` / `.town-tabs` |
| `.ga-field` | `input[type=text]…` base styles |
| `.ga-switch` | `.check-label input[type=checkbox]` (apple.css skin) |
| `.ga-slider` | `input[type=range]` |
| `.ga-chip` / `.ga-status-pill` (`is-ready/-working/-queued/-done/-error`) | `.qc` / `.tp-ready` / `.seat-chip` |
| `.ga-msg-user / -assistant / -system` | `.msg.user` / `.msg.ai` / `.msg.system-msg` |
| `.ga-tool-call` (details/summary; `is-done`/`is-error`) | `.tool-card` |
| `.ga-agent-card` (+ `-avatar`) | `.agent-card` |
| `.ga-sheet` (+ `-head/-title/-body/-foot`) | `.modal` |
| `.ga-toast` | `.toast` |
| `.ga-empty` (+ `-icon/-title/-hint`) | `.empty` |
| `.ga-skeleton` | new |
| `.ga-meter` (`is-green/-orange/-red`) | `.ctx-meter` |
| `.ga-voice-orb` (`data-state=idle/listening/thinking/speaking`) | replaces `#orbCanvas` particle paint |

## Stylesheet cascade (order matters)

`design-tokens.css` → `style.css` (calm token-driven base) → `light-mode.css` (scrim tints) → `depth.css` (layout/responsive/a11y/motion) → `apple.css` (Apple skin refinements) → `components.css` (`.ga-*` recipes) → `reduced-motion.css` (global kill-switch).
