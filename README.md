# Health Inspect

A first-party, dependency-free Chrome extension that displays source-linked Bay Area
restaurant health inspection records beside Google Maps.

## Install and use

1. Requires desktop Chrome 116+. Only load unpacked extensions where your
   organization's policies allow it.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   and select this directory (the one containing `manifest.json`).
3. Open (or reload) a Google Maps tab and select a restaurant.
4. The **Health Inspect** panel appears automatically and loads records for the
   detected county — no click needed. Selecting another restaurant refreshes it.

The extension icon opens a small settings popup (display-mode switch and a
button to open the native Chrome side panel manually), not the results panel
itself.

No build step, install, API key, account, or backend is required — it's plain
browser-native JavaScript modules, no TypeScript or third-party dependencies.

### Display modes

A switch at the top of the panel controls where results appear:

- **Off** (default) — **Floating panel**: overlay on the right side of Maps.
- **On** — **In Maps information panel**: a compact card inserted into Maps'
  own info panel, with an expandable section for full details and match
  controls.

The choice is saved locally and applies across tabs and restarts.

## Data coverage

| County | Behavior | Official source |
| --- | --- | --- |
| San Francisco | Live public JSON; ratings, inspection history, violation text, inspector notes | [Dataset](https://data.sf.gov/d/tvy3-wexg) |
| Santa Clara | Live public JSON; facility matching, scores, placard results, inspection history, violations | [County data](https://data.sccgov.org/stories/s/8ptb-6646) |
| San Mateo | Live public portal; facility matching, visit results, history, violations, compliance dates | [Inspection search](https://smcehs.my.site.com/s/inspection-report-search?language=en_US) |

Sources were investigated on September 13, 2026. San Mateo has no current open
dataset, so the extension reads its public Salesforce portal directly: it opens
(or reuses) an official county portal tab in the background and sends normal,
anonymous, read-only requests through a small injected bridge — no credentials,
no header/CORS bypassing, only four verified read actions.

Each county's data model differs (e.g. Santa Clara's headline score comes from
its most recent *routine* inspection, not a follow-up; SF's violation text is
combined prose rather than itemized entries; San Mateo has no numerical score).
The extension surfaces these distinctions rather than normalizing them into a
single cross-county score.

Try it with **Tartine Bakery, San Francisco**, **House of Bagels, Santa Clara**,
or **Town, San Carlos**.

## Matching confidence

- An exact or single-candidate match loads automatically, labeled accordingly
  (**Only matching record** vs. a true exact match).
- Conservative fuzzy matching (typos, word order, street abbreviations) loads
  automatically only when unique, labeled **Similar name and address**.
- Ambiguous matches require you to pick via **Change match**; your choice is
  remembered for that selection only.
- A match is not proof of identical ownership across time — check official
  identity and dates yourself.

Inspection lookups only run for restaurants/cafes/bakeries/similar food-service
categories on Maps, and only recognize U.S. English Maps category labels. The
panel only appears for addresses in one of the three currently supported
counties (San Francisco, San Mateo, Santa Clara) — other places are treated
like non-food places (no panel shown).

## Architecture

- `content.js` / `inpage-panel.js` — observe Maps' selected restaurant and render
  the in-page panel (Shadow DOM, anchored to the address section).
- `background.js` — service worker that performs county lookups.
- `sidepanel.js` — renders the native Chrome side panel.
- `options.js` / `options.html` — the toolbar-icon settings popup (display-mode
  switch, manual side-panel launcher).
- `lib/matching.js` — conservative facility matching.
- `lib/summary.js` — deterministic summaries (no AI service involved).
- `lib/county-detection.js` — maps a Maps address to a supported county (or
  `null`), gating whether the panel appears at all; `lib/san-mateo*.js` is the
  San Mateo Salesforce/Aura adapter. Add a county by extending its `cities`
  map and `lib/counties.js`'s data-source config — no other code changes
  needed.

See [AGENTS.md](AGENTS.md) for a fuller map of the codebase.

## Privacy and scope

- Reads only the currently selected place's visible name/address.
- Sends lookups only to the official data hosts declared in `manifest.json`,
  without credentials. No analytics, no third-party AI.
- San Mateo requires the `scripting` permission to inject its read-only bridge
  into the official county portal tab; that bridge omits cookies from its
  requests.
- Selection state lives in `chrome.storage.session` and clears when a tab closes
  or navigates — not persistent history.
- Supported URLs: `www.google.com/maps*`, `maps.google.com/*`. Localized Google
  domains and mobile are not supported.

## Development

Requires Node.js 22+.

```sh
npm test               # unit tests (node --test)
npm run check          # manifest reference + JS syntax validation
npm run test:browser   # headless-browser checks, isolated Chrome profile
npm run test:live      # read-only checks against real county data sources
npm run test:extension-live  # end-to-end check with the unpacked extension
```

Browser/extension-live checks use isolated temporary Chrome profiles and never
touch your regular profile. After editing extension files, reload it at
`chrome://extensions` and reload the Maps tab.

## Troubleshooting

If Chrome reports `Extension context invalidated` after reloading the extension,
reload the Maps tab too — a recovery notice with **Reload Maps** will also appear
in the panel. Other errors show their actual message with the same reload action.
