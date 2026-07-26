# RayLink interface system

## 1. Visual theme and atmosphere

RayLink is a precise, quiet operations console for teams running sing-box infrastructure. The interface uses a near-black graphite canvas, compact information density, low-radius geometry, and status color only when it conveys operational meaning.

The primary signature is the deployment trail: every configuration change is shown as a traceable sequence from draft to validation, snapshot, rollout, and health confirmation.

Each user owns an independent entitlement. The user workspace creates and edits identity, traffic allowance, expiry, node scope, and client capabilities in one flow.

The information architecture uses six stable destinations: Overview, Users, Services, Policies, Operations, and System. High-frequency managed fields stay in simple forms; raw configuration is exposed as an advanced, read-only preview so the interface never implies that an unconnected control has changed the runtime.

## 2. Color palette and roles

| Token | Value | Role |
| --- | --- | --- |
| Canvas | `oklch(0.125 0.008 165)` | Application background |
| Rail | `oklch(0.145 0.008 165)` | Primary navigation |
| Surface 1 | `oklch(0.17 0.009 165)` | Tables and content sections |
| Surface 2 | `oklch(0.20 0.01 165)` | Elevated controls and drawers |
| Border | `oklch(0.31 0.012 165 / 0.55)` | Dividers and control outlines |
| Text | `oklch(0.93 0.008 155)` | Primary text |
| Muted | `oklch(0.68 0.014 160)` | Secondary labels |
| Accent | `oklch(0.78 0.145 154)` | Healthy status and primary actions |
| Warning | `oklch(0.80 0.13 82)` | Degraded status and caution |
| Danger | `oklch(0.67 0.18 27)` | Offline status and destructive actions |

## 3. Typography rules

Brand words: precise, industrial, calm.

The reflex choices Inter, Space Grotesk, and IBM Plex Sans are rejected. The interface uses Bahnschrift or DIN Alternate when available because their engineered proportions match network instrumentation; Avenir Next and PingFang SC provide readable fallbacks.

| Level | Size | Weight | Line height | Letter spacing |
| --- | --- | --- | --- | --- |
| Page title | 30px | 600 | 1.08 | -0.022em |
| Section title | 20px | 600 | 1.2 | -0.012em |
| Body | 14px | 450 | 1.5 | normal |
| Compact body | 10–12px | 450 | 1.5 | normal |
| Label | 10px | 600 | 1.3 | 0.04em |
| Data | 13px | 500 | 1.4 | normal, tabular numerals |

## 4. Component stylings

- Primary buttons use the accent fill, dark ink, 8px radius, and 40px minimum height. Hover raises luminance slightly; active scales to 0.96; disabled reduces opacity.
- Secondary buttons use Surface 2 with a standard divider border. Danger buttons use a quiet danger tint before confirmation.
- Inputs use Surface 1, 8px radius, a 1px divider outline, and a two-pixel accent focus ring.
- Tables are cardless operational surfaces with hairline row dividers, sticky headers, right-aligned numeric data, and compact 48px rows.
- Navigation is a 232px rail with one sliding accent indicator and restrained active fill.
- User management has one rail destination and one primary create-user flow; entitlement fields live in the user drawer.
- Drawers are fixed detail surfaces at the right edge. They retain page context and never behave like centered modals.

## 5. Layout principles

The spacing scale is 4, 8, 12, 16, 24, 32, and 48px. Desktop uses a fixed navigation rail and a fluid workspace capped at 1600px. Dashboard status is a single continuous strip, followed by asymmetric operational columns rather than a uniform card grid.

## 6. Depth and elevation

Depth comes from luminance steps, not dark drop shadows. The canvas is level 0, navigation and broad sections are level 1, controls are level 2, and the edit drawer is level 3. Borders are reserved for layout separation, tables, and controls.

## 7. Do's and don'ts

- Do use green only for healthy states and decisive actions.
- Do expose the active deployment and its author near the top of every view.
- Do keep identifiers, bandwidth, and latency in tabular numerals.
- Do show exact validation failures beside the affected field.
- Do keep rollback visible wherever a deployment can be published.
- Don't use decorative gradients, glass blur, or neon cyberpunk treatments.
- Don't turn every content group into an identical rounded card.
- Don't hide operational detail behind tooltips alone.
- Don't animate layout dimensions or use `transition: all`.

## 8. Responsive behavior

At 920px the rail becomes a compact top bar with an accessible navigation drawer. At 680px dense tables become labeled record rows, two-column forms collapse to one column, and the primary navigation becomes a four-item bottom bar. All touch targets remain at least 40px and safe-area insets are respected.

## 9. Agent prompt guide

Quick colors: canvas `oklch(0.125 0.008 165)`, surface 1 `oklch(0.17 0.009 165)`, surface 2 `oklch(0.20 0.01 165)`, accent `oklch(0.78 0.145 154)`, warning `oklch(0.80 0.13 82)`, danger `oklch(0.67 0.18 27)`, text `oklch(0.93 0.008 155)`.

- Create an operations page on the canvas color with a 30px weight-600 title, 1.08 line-height, -0.022em tracking, text color, and an 8px-radius accent action at 40px height.
- Create a dense user table on surface 1 with 48px rows, 12px uppercase labels at weight 600 and 0.04em tracking, tabular numeric columns, 1px border dividers, and 8px-radius inputs.
- Create a right edit drawer on surface 2 at 440px desktop width and full mobile width, with 24px padding, 12px outer radius only on the exposed edge, and a sticky 64px action footer.
- Create a deployment trail with five 40px steps connected by 1px border lines; completed steps use accent, the active step uses warning, and pending steps use muted text.
