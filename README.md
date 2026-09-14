# Health Inspect

A first-party, dependency-free Chrome extension that displays source-linked Bay Area
restaurant inspection records beside Google Maps.

## Run the prototype

1. Use desktop Chrome 116 or newer. Review the source and use only a browser where
   your organization's policies permit loading your own unpacked extension.
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and
   choose this directory (the directory containing `manifest.json`).
3. Open or reload an English-language `https://www.google.com/maps/` tab.
4. Select a restaurant so its name and street address are visible.
5. The **Health Inspect** panel appears on the right of Maps and automatically
   loads records. No extension-icon click is needed.
6. The county is detected automatically from the Maps address. Selecting another place loads
   its records automatically. **Close** dismisses the panel for the current
   selection; it reappears when you select another place.

The extension icon still opens the optional native Chrome sidebar. Close the
in-page panel if you prefer using that sidebar.

### Choose where results appear

Use **Automatic display** at the top of Health Inspect, either in the displayed
records or in the extension-icon sidebar:

- **Floating panel** preserves the existing right-hand overlay and is the default.
- **In Maps information panel** inserts a compact card immediately above the
  restaurant's address/information section, below its service options. Expand
  **Inspection details, history, and match settings** for the full records,
  county override, and matching controls. Ambiguous matches and lookup errors
  reveal those controls automatically.

The choice is saved locally, applies across Maps tabs, and survives browser
restarts. Switching modes keeps the selected restaurant; newer Chrome versions
also preserve the existing iframe and loaded results during the move. Older
Chrome versions may reload the embedded view. The native Chrome sidebar itself
is unchanged and remains available through the extension icon.

If Maps removes or rebuilds its information section, the extension restores its
card without adding duplicates. If the insertion point is unavailable, it shows
an explicit notice in the floating panel and returns inline when the section
reappears. Neither mode changes Google's ratings. **Close** dismisses the current
restaurant's automatic display; selecting another restaurant shows it again.

No build step, package installation, API key, account, or backend is required.
The implementation uses browser-native JavaScript modules rather than TypeScript
to keep this first prototype directly loadable and free of third-party dependencies.
Do not bypass managed-browser restrictions if unpacked extensions are disabled.

## Data coverage

| County | Prototype behavior | Official source |
| --- | --- | --- |
| San Francisco | Live public JSON; current status ratings, inspection history, combined violation text, and inspector notes | [2024-present dataset](https://data.sf.gov/d/tvy3-wexg) |
| Santa Clara | Live public JSON; facility matching, scores, placard results, inspection history, and violation observations | [County data collection](https://data.sccgov.org/stories/s/8ptb-6646) |
| San Mateo | Live public portal; facility matching, visit results, inspection history, violations, compliance dates, and field readings | [County inspection search](https://smcehs.my.site.com/s/inspection-report-search?language=en_US) |

Sources were investigated on September 13, 2026. San Mateo's accessible older
open dataset ends January 24, 2022; this prototype deliberately does not use it as
current health information. Current San Mateo records come directly from its
public Salesforce portal instead.

The San Mateo adapter reads current framework metadata from the public search
page, then uses anonymous, read-only Aura actions for facility search, inspection
history, violations, and field readings. Salesforce rejects extension-origin
POSTs, so **San Mateo opens or reuses an official county portal tab in the
background**. Leave that tab open while records load. Maps remains the active tab.
The extension injects its own small, read-only bridge into that page and sends
normal same-origin requests; it does not rewrite Origin headers, disable CORS,
or bypass access controls. The bridge accepts only the four verified read
actions, with credentials omitted and the public token set to `null`.

The adapter does not evaluate downloaded code, hard-code framework versions, or
use user tokens. The portal tab loads the county's normal website assets. This is the
website's public interface, not a versioned open-data contract; website changes
can require adapter updates. Retry refreshes the public metadata.

San Mateo exposes visit results but no numerical score or structured inspection
type. Inspector notes are shown as plain text, not used to guess routine visits.
Its license/fiscal status is **not** a health rating. Zero *open* violations can
coexist with violations corrected on site, so details are fetched regardless of
that count. The UI distinguishes retrieved violation entries from open violations,
preserves recorded compliance dates, and does not treat empty details as a clean
inspection. Different licenses at the same address remain separate candidates.

The SF adapter uses `tvy3-wexg`, not the retired numeric-score datasets.
Its combined `violation_codes` prose contains commas and cannot safely be split
into individual violations, so it is displayed verbatim alongside the county's
reported count. Recurring-category summaries are available for Santa Clara's
structured records, not inferred from SF's combined prose.

Santa Clara's headline numerical score comes from its **most recent routine
inspection**, not a newer reinspection or follow-up. This is queried separately
so the score is available even if that routine visit falls outside the 20-entry
timeline. The score's date and source link are displayed separately from the
latest overall inspection and its result. If the most recent routine inspection
has no score, an older routine score is not substituted.

The Santa Clara adapter joins facilities `vuw7-jmjk`, inspections `2u2d-8jej`,
and violations `wkaa-4ccv`. The inspection ID column is actually spelled
`inpsection_id`; the violation table uses `inspection_id`. Feed freshness comes
from `itys-r3sp`. Category titles are not interpreted as observations; inspector
comments are preserved, including qualifications.

History is limited to 20 recent available inspections. Future-dated source rows
are excluded using the current California date; such a data-quality anomaly was
observed in the SF dataset. Retrieval time and feed freshness are shown separately
from each inspection date. SF and Santa Clara timeline links point to official
JSON entries, not invented PDF/report URLs. San Mateo links open the facility's
official inspection history and identify the visit number; its public component
does not expose a verified per-visit deep link. The county search links lead to
the human-readable report sites.

For a first live example, search Maps for **Tartine Bakery, 600 Guerrero St,
San Francisco**, **House of Bagels, 5231 Stevens Creek Blvd, Santa Clara**, or
**Town, 716 Laurel St, San Carlos**.
If Maps uses a different business name or suite, confirm the offered facility.

## What the interface means

- A unique exact normalized name-and-address match loads automatically. If only
  one candidate is returned, it also loads automatically without confirmation,
  even when name or suite details differ. Such results are labeled **Only matching
  record · selected automatically**, not presented as verified exact matches.
  Multiple ambiguous candidates still require selection; conflicting ZIP codes
  remain excluded from matching.
- Conservative fuzzy matching tolerates minor name typos, reordered name words,
  common street abbreviations, and small street spelling differences. A unique
  strong approximate match loads automatically and is labeled **Similar name and
  address**, with an explanation that it is not an exact match. Building numbers
  and suite identifiers are not fuzzily equated. Multiple plausible approximate
  matches still require a choice. The separate single-candidate rule can still
  display a sole non-exact result, but does not label it a strong fuzzy match.
- A confident match loads immediately. **Change match** beside the facility
  identity lists other returned candidates with their addresses and county IDs,
  so you can correct the association without changing your Maps selection.
  A manual choice is labeled **Match selected by you**, and **Use automatic
  matching** resets it. Choices apply only to the current selection; retrying a
  failed manual lookup retains your choice. If no alternative candidates are
  available, the control links to the official county search rather than guessing.
- Match confirmation is not proof that the current business has the same ownership
  as a historical facility. Check the official identity and dates.
- Scores remain in the county's own system. There is no invented cross-county score.
- Summaries describe only the records retrieved. A repeated description is counted
  once per routine inspection; follow-up visits do not inflate recurrence.
- No missing records, absent violations, or old scores are interpreted as evidence
  of current cleanliness, correction, reopening, or food safety.
- Source failures are displayed as errors, not disguised as empty histories.
- Inspection lookups only run for recognized Google Maps food-service categories:
  restaurants, cafes, bakeries, and similar prepared-food venues. Hotels, parks,
  banks, grocery stores, restaurant-supply stores, and unknown/missing categories
  are skipped without querying county data. The business name is never used to
  guess eligibility. Selecting a skipped place clears and hides previous records.
  English Maps categories are required; if Maps changes its category markup, the
  extension skips the place rather than treating it as a restaurant.
- County detection uses the city/locality and California state component of the
  Maps address, including common unincorporated communities. It distinguishes
  South San Francisco from San Francisco and East Palo Alto from Palo Alto.
  No geocoding service or location permission is needed. The manual county control
  appears below the inspection results and stays collapsed unless detection fails;
  an override applies only to that
  selection, and the next restaurant is detected again. Unknown or out-of-area
  addresses are not assigned a county using a guessed ZIP prefix.

## Architecture

`content.js` observes Maps' visible restaurant details and URL changes. The shared
parser rejects mismatched URL/title snapshots during navigation. Updates are
debounced and sent in order. A session-only place snapshot is stored per tab.
The background handler also records the publishing Maps frame/document ID.
Both panel modes request selection reads through that handler, which routes them
to the recorded document (or frame if no document ID is available), not a
hard-coded frame `0`. The sender must still be this extension on an allowed
HTTPS Google Maps URL. Tab loading notifications do not erase this binding:
loading an embedded frame is not evidence that the Maps document has departed.
The Maps document clears its selection on `pagehide` and republishes on `pageshow`.
New documents replace the source mapping; closing a tab removes it. Reads always
query the recorded document rather than returning a potentially stale cached place.

A lightweight periodic DOM probe catches delayed details even if a mutation
notification is missed. Unchanged selections do not produce new county lookups.
Panels also re-read on tab load-state updates, and initial empty reads show
selection/category guidance instead of leaving the initial connection message.

`background.js` performs county lookups in the extension service worker.
`lib/matching.js` handles conservative facility matching. `lib/summary.js` produces
deterministic summaries without an AI service.

`sidepanel.js` renders results using text nodes, not source-supplied HTML. Request
generations prevent late replies for a previous selection from replacing the
current restaurant's records. Tab switches and deselection clear old results.

`inpage-panel.js` automatically displays an extension-owned iframe over the right
side of Maps, or immediately before its information region, according to the
locally saved display preference. Placement is anchored to the region containing
`data-item-id="address"`, not generated Google class names. It appears after a
stable place selection is published. A Shadow DOM wrapper
isolates its controls from Maps styles. The iframe reuses the sidebar UI and is
bound to its containing tab, not whichever tab happens to be active. Closing it
unloads that embedded page. Old results are hidden immediately on selection
changes, before another lookup begins. Google's ratings are not modified.

The optional native sidebar still requires an explicit user action under Chrome's
Side Panel API. Automatic display uses the in-page panel instead of attempting to
open the native sidebar after an asynchronous lookup.

## Privacy and scope

The extension reads the currently selected place's visible name and address.
Lookups send relevant search fields to the official data hosts declared in the
manifest; requests omit credentials. There is no analytics or third-party AI.
San Mateo also needs the `scripting` permission to install the extension's own
read-only bridge in its official portal tab. Navigating that tab is a normal
website visit and may use existing county-site cookies; the bridge's API
requests explicitly omit them. Closing the county tab does not close Maps,
but another San Mateo lookup may open a new portal tab.
Only the panel UI and its display helpers are web-accessible, restricted to the
supported Google origins; data-provider code is not exposed as a page resource.
Selection state is in `chrome.storage.session`, not persistent browsing history,
and is removed when a tab closes or navigates.

Supported Maps URLs include `www.google.com/maps`, its query-string entry pages,
`www.google.com/maps/*`, and `maps.google.com/*`. Localized
Google domains, the Google Maps mobile app, and mobile Chrome are not supported.
Maps does not provide a stable DOM integration contract; selector changes may
require updating `content.js`. Unsupported pages show selection guidance rather
than guessed restaurant details.

## Development

Node.js 22 or newer:

```sh
npm test
npm run check
npm run test:browser
npm run test:live
npm run test:extension-live
```

The browser check uses an isolated temporary Chrome profile, a loopback-only
server, and explicit synthetic test fixtures. It does not install the extension,
touch your regular Chrome profile, or use fixtures as live inspection records.
On systems other than macOS, set `CHROME_BIN` to the Chrome executable.

Browser checks cover sidebar rendering, stale-reply rejection, error/retry states,
untrusted-text rendering, and clearing the selection. Unit tests cover Maps
navigation, facility matching, and summaries. These do not replace a manual check
of the unpacked extension against the current Google Maps UI.

`test:live` makes small read-only requests to the three official data hosts and
checks real matching and record retrieval. It can fail if a source is unavailable
or its public records change. It runs in Node, so it does not establish browser
Origin compatibility.

`test:extension-live` additionally loads this unpacked extension into a throwaway
Chrome profile and exercises the real panel-to-worker-to-county-tab path. It
checks San Mateo's same-origin requests, omitted cookies, tab reuse, and that the
current tab stays active. It requires a recent Chrome with the
`Extensions.loadUnpacked` debugging API (verified with Chrome 152). The diagnostic
uses `--enable-unsafe-extension-debugging` only for this isolated test process,
communicates through a local pipe, and removes its temporary profile afterward.
It does not change your regular profile, disable browser security, or rewrite
request headers. The other tests use only synthetic fixtures.

After editing extension files, reload the extension at `chrome://extensions` and
reload the Maps tab.

## Troubleshooting extension reloads

Reloading or updating an extension invalidates its content scripts in existing
Maps tabs. Reload those tabs as well; reloading only the extension is not enough.
If Chrome reports `Extension context invalidated`, the old script stops its
observer, polling, and queued messages. A recovery notice with **Reload Maps**
appears even if the inspection panel never finished loading.

Other messaging or panel-rendering failures show their actual error text, stop
repeated background attempts, and offer the same explicit reload action. A stack
trace pointing at the `content.js` logger alone does not identify the cause; the
notice's **Details** text distinguishes a stale extension context from a storage,
messaging, or rendering error.

`No acknowledgement from the extension` means the background handler did not
reply; it is different from an invalidated context. Maps entry URLs without a
trailing slash are supported, and selection messages rejected by the background
handler now receive explicit reasons instead of an empty reply.
