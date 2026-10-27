# Accessibility Panel and Motion Design

## Goal
Let each user make DashBank readable and comfortable on their own device, and make
motion smoother. Settings are saved per device.

## Non-goals
- Syncing settings across devices.
- New chart types, or changes to existing Hebrew or English wording.
- Any third-party accessibility widget or external script.

## Settings

| Setting | Values | Default | Effect |
|---|---|---|---|
| Text size | 100 / 115 / 130 / 150 (%) | 100 | Scales all text via a root size |
| High contrast | off / on | off | Stronger palette, 2px borders, stronger focus rings |
| Theme | system / light / dark | system | Overrides the device colour scheme |
| Dyslexia font and spacing | off / on | off | Self-hosted rounded font, line height 1.8, letter spacing 0.02em |
| Motion | system / on / off | system | `off` disables all animation, `on` enables it even if the device requests less |

Stored under one key, `dashbank.a11y`, as JSON. Invalid or missing values fall back to defaults.
If storage is unavailable, settings apply for the current page only.

## Architecture

- **`public/a11y-settings.js`** (pure logic, no DOM): `normalise(raw)`, `load(storage)`,
  `save(storage, settings)`, `toAttributes(settings)` returning
  `{ 'data-text': '115', 'data-contrast': 'high', 'data-theme': 'dark', 'data-font': 'dyslexia', 'data-motion': 'off' }`.
- **`public/a11y-panel.js`** (DOM): gear button, bottom sheet built from the existing sheet
  component, applies attributes to `<html>` and announces changes in a live region.
- **`public/styles.css`**: all sizes, colours and spacing move to CSS variables. Attribute
  selectors (`:root[data-contrast="high"]`, `:root[data-theme="dark"]`, `:root[data-motion="off"]`)
  override them. The existing `prefers-color-scheme` and `prefers-reduced-motion` rules remain
  as defaults for the `system` options.
- **Fonts:** the dyslexia font file is served from `public/fonts/` with OFL licence text.
  No requests to Google Fonts or any other external host.

## Motion
- Tab switch: directional slide with crossfade. Uses the View Transitions API when available,
  otherwise a CSS class fallback.
- Cards rise in with a short stagger on first load and on month change.
- Charts animate their drawing with eased curves; bottom sheet uses a spring-like curve.
- Pull-to-refresh uses a bounce on release.
- Only `transform` and `opacity` are animated, so frames stay smooth on phones.
- With motion `off`, every animation and transition duration is 0 and charts render at final state.

## UX fixes
1. Month changes are already announced (`aria-live="polite"` on the month label), so no change is needed.
2. Give icon-only buttons a tooltip (`title`) so sighted mouse and keyboard users see their purpose.
3. Add the in-app theme switch (covered by the Theme setting).

## Error handling
- Corrupt stored JSON is discarded and replaced with defaults.
- Unknown values are dropped individually, so one bad field doesn't reset everything.

## Testing
- **Unit (`node:test`):** `normalise` and `toAttributes` on valid, invalid and partial input;
  `load` and `save` with a fake storage, including storage that throws.
- **Browser (Playwright, existing a11y suite):** each setting changes the matching attribute;
  values persist across reloads; panel is operable by keyboard alone; with motion `off`,
  computed animation durations are 0; contrast ratios of the high-contrast palette meet 7:1
  for body text and 4.5:1 for secondary text.
- **Visual:** screenshots at 390px and 1440px for text size 150% and high contrast in both themes.

## Open points
- A Hebrew-capable dyslexia-friendly font has not been chosen. Until one is verified, Hebrew
  uses the system font with the dyslexia spacing.
- The high-contrast palette was checked numerically at 7:1 or better for text tokens, and the test suite enforces it.
- The phone status-bar colour (`theme-color` meta) still follows the device scheme, not a forced in-app theme.
