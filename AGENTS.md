# Health Inspect

> A dependency-free Chrome (Manifest V3) extension that shows source-linked Bay Area
> restaurant health inspection records beside Google Maps. No build step, no
> TypeScript, no third-party packages.

## What This Is

Health Inspect detects the selected restaurant on Google Maps, matches it against
official county inspection data (San Francisco, Santa Clara, San Mateo), and
renders results either in a floating in-page panel, inline in Maps' own info
panel, or in the native Chrome side panel. See `README.md` for full product
behavior, data coverage per county, and privacy/security details — this file is
the map for making code changes.

## Where to Look

| Topic | Location | Read When |
|-------|----------|-----------|
| Extension wiring (permissions, content scripts, resources) | `manifest.json` | Adding/moving files, new hosts, new permissions |
| Background service worker | `background.js` | Extension-icon/side-panel lifecycle changes |
| Maps content script + in-page panel | `content.js`, `inpage-panel.js` | Changing how the panel renders on Maps |
| Native side panel UI | `sidepanel.html`, `sidepanel.js`, `sidepanel.css` | Changing the Chrome side-panel UI |
| County detection & source dispatch | `lib/county-detection.js`, `lib/counties.js`, `lib/sources.js` | Adding a county or changing routing |
| Restaurant name/address matching | `lib/matching.js` | Improving match accuracy |
| Per-county data adapters | `lib/san-mateo.js`, `lib/san-mateo-request.js`, `lib/san-mateo-transport.js` | San Mateo portal/Aura bridge changes |
| San Mateo in-page bridge (runs in the portal tab) | `san-mateo-bridge.js` | Changing the read-only bridge injected into the county portal |
| Shared HTTP + summary helpers | `lib/http.js`, `lib/summary.js`, `lib/source-utils.js` | Cross-county fetch/formatting logic |
| Maps DOM context extraction | `lib/maps-context.js` | Reading restaurant name/address from Maps DOM |
| Display mode persistence | `lib/display-preferences.js` | Floating vs. inline vs. sidebar preference logic |
| Unit tests | `test/*.test.js` | Any change to `lib/`, `content.js`, or `background.js` |
| Manifest/syntax validation, live/browser checks | `scripts/` | Before committing; see Build & Test below |

## Build & Test

No build step — load `manifest.json` directly via `chrome://extensions` →
Developer mode → Load unpacked (see `README.md` for full steps).

| Command | Purpose |
|---------|---------|
| `npm test` | Runs `node --test` over `test/*.test.js` (Node's built-in test runner). |
| `npm run check` | Validates every file referenced in `manifest.json` exists and all `.js`/`.mjs` files parse (`scripts/check.mjs`). |
| `npm run test:browser` | Headless-browser checks (`scripts/browser-check.mjs`). |
| `npm run test:live` | Exercises live county data sources (`scripts/live-check.mjs`) — hits real endpoints. |
| `npm run test:extension-live` | End-to-end extension check against live sources (`scripts/extension-live-check.mjs`). |

Run `npm test` and `npm run check` before any commit touching `manifest.json`,
`lib/`, `background.js`, `content.js`, or `sidepanel.js`.

## Critical Rules

1. Keep the extension dependency-free and TypeScript-free — plain, browser-native
   JavaScript modules only (`type: "module"` throughout).
2. Any file referenced by `manifest.json` (background, content scripts, side
   panel, web-accessible resources) must stay in sync with `scripts/check.mjs`'s
   `referenced` list — update both together.
3. The San Mateo bridge (`san-mateo-bridge.js`) must remain read-only: only the
   four verified Aura actions, no credentials, no Origin/CORS rewriting, no
   evaluating downloaded code.
4. Never bypass managed-browser or extension-loading restrictions.

## Never Do

1. Don't add npm dependencies or a bundler/build step without strong justification.
2. Don't add write/credentialed requests to any county portal or data source.
3. Don't hard-code assumptions about Salesforce/Aura framework versions in the
   San Mateo adapter — it reads current metadata from the public page.
4. Don't duplicate manifest-referenced file lists — let `scripts/check.mjs`
   validate them instead of hand-checking.
