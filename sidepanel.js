import { COUNTIES } from "./lib/counties.js";
import { summarize } from "./lib/summary.js";
import "./lib/display-preferences.js";

const $ = id => document.getElementById(id);
let activeTabId;
let windowId;
let place = null;
let requestVersion = 0;
let contextVersion = 0;
let retryCandidateKey;
let selectionInitialized = false;
let readVersion = 0;
const embedded = new URL(location.href).searchParams.get("embedded") === "1";
let displayMode = "floating";
let needsAttention = false;

function reportSize() {
  if (!embedded) return;
  // Only dimensions and the selection key cross the iframe boundary, never county records.
  window.parent.postMessage({
    type: "HEALTH_INSPECT_SIZE", key: place?.key,
    height: Math.ceil(document.body.getBoundingClientRect().height),
  }, "*");
}

globalThis.HealthInspectDisplay.observe(value => {
  const changed = displayMode !== value;
  displayMode = value;
  document.body.classList.toggle("inline-view", embedded && value === "inline");
  if (changed || !embedded) $("record-details").open = !embedded || value !== "inline" || needsAttention;
  reportSize();
}, error => {
  console.error("[Health Inspect] Could not read display preference:", error);
});
if (embedded) {
  new ResizeObserver(reportSize).observe(document.body);
  $("record-details").addEventListener("toggle", reportSize);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(text, url) {
  const node = element("a", text);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Unsupported source link.");
  node.href = parsed.href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

function status(text, kind = "notice") {
  $("status").replaceChildren(element("div", text, kind));
  $("inline-result").replaceChildren(element("div", text, kind));
}

function renderCompact(data) {
  const { facility, inspections } = data;
  const latest = summarize(inspections).latest;
  const root = $("inline-result");
  root.replaceChildren(element("h2", "Health inspection"));
  root.append(element("p", facility.name));
  const county = COUNTIES[data.county || $("county").value];
  root.append(element("p", `${county?.name || "Official county records"} · via Health Inspect`, "hint"));
  if (!data.confirmed && !facility.exactMatch) {
    root.append(element("p", facility.matchBasis === "similar"
      ? "Approximate match - review facility details below."
      : "Only candidate - name or address may differ. Review the match below.", "hint"));
  } else if (data.confirmed) root.append(element("p", "Match selected by you", "hint"));
  if (data.county === "sc") {
    const routine = data.latestRoutineInspection;
    root.append(element("p", routine
      ? `Official routine score: ${routine.score ?? "not provided"} · ${routine.date}`
      : "Official routine score: unavailable"));
  }
  if (latest) {
    if (data.county !== "sc" && latest.score != null) root.append(element("p", `Official score: ${latest.score}`));
    root.append(element("p", `Latest inspection: ${latest.date} · ${latest.result || "Result not provided"}`));
    if (latest.retrievedViolationCount !== undefined) root.append(element("p", `Retrieved violation entries: ${latest.retrievedViolationCount}`, "hint"));
    else if (latest.violationCount) root.append(element("p", `County-reported violations: ${latest.violationCount}`, "hint"));
  } else root.append(element("p", "No inspection entries returned. This does not establish a clean record."));
  root.append(element("p", "Historical inspection results are not a statement of current food safety.", "hint"));
  root.append(link("Official county records", data.source.url));
}

function renderSources() {
  $("sources").replaceChildren(...Object.values(COUNTIES).map(county => link(county.name, county.url)));
}

function candidateButton(candidate, selectedKey) {
  const selected = candidate.candidateKey === selectedKey;
  const button = element("button", `${candidate.name}${selected ? " (current match)" : ""}`, "candidate");
  button.dataset.candidateKey = candidate.candidateKey;
  button.disabled = selected;
  button.append(element("small", `${candidate.address}${candidate.city ? `, ${candidate.city}` : ""} · ID ${candidate.applicationNumber || candidate.id}`));
  if (candidate.fiscalStatus) button.append(element("small", `License/fiscal status: ${candidate.fiscalStatus} (not a health rating)`));
  if (!selected) button.addEventListener("click", () => void runLookup(candidate.candidateKey));
  return button;
}

function matchChoices(data) {
  const details = element("details");
  details.className = "match-choices";
  details.append(element("summary", "Change match"));
  details.append(element("p", "Choose another county facility for this Maps selection. Check the address and unit; historical businesses may have different ownership.", "hint"));
  const candidates = data.candidates || [];
  for (const candidate of candidates) details.append(candidateButton(candidate, data.facility.candidateKey));
  if (!candidates.some(candidate => candidate.candidateKey !== data.facility.candidateKey)) {
    details.append(element("p", "No alternative candidates were returned for this name/address.", "hint"));
    details.append(link("Search the official county records", data.source.url));
  }
  if (data.confirmed) {
    const reset = element("button", "Use automatic matching", "secondary");
    reset.dataset.action = "auto-match";
    reset.addEventListener("click", () => void runLookup());
    details.append(reset);
  }
  return details;
}

function renderRecord(data) {
  const { facility, inspections, source } = data;
  const card = element("section", undefined, "card");
  const matchLabel = data.confirmed ? "Match selected by you"
    : facility.exactMatch ? "Name and street address matched"
      : facility.matchBasis === "similar" ? "Similar name and address · selected automatically"
        : "Only matching record · selected automatically";
  card.append(element("span", matchLabel, "tag"));
  const facilityLocation = [facility.address, facility.city, facility.postalCode].filter(Boolean).join(", ");
  card.append(element("h2", facility.name), element("p", facilityLocation, "muted"));
  card.append(element("p", `County facility ID: ${facility.applicationNumber || facility.id}`, "hint"));
  if (facility.fiscalStatus) card.append(element("p", `License/fiscal status: ${facility.fiscalStatus} (not a health rating)`, "hint"));
  if (!data.confirmed && !facility.exactMatch) {
    const explanation = facility.matchBasis === "similar"
      ? "This is an approximate match for a minor name or street variation, not a verified exact match. The county facility details are shown above."
      : "This was the only candidate returned. Its name, address, city, or unit details may differ from Google Maps.";
    card.append(element("p", explanation, "hint"));
  }
  card.append(matchChoices(data));
  if (source.warning) card.append(element("p", source.warning, "notice"));
  card.append(element("p", `Retrieved: ${new Date(source.retrievedAt).toLocaleString()}`, "hint"));
  if (source.updatedAt) card.append(element("p", `Source data updated: ${source.updatedAt}`, "hint"));
  else card.append(element("p", "Source update date: not provided", "hint"));
  if (source.note) card.append(element("p", source.note, "hint"));
  card.append(link("Open county report search", source.url));
  if (source.dataset) {
    const paragraph = element("p");
    paragraph.append(link("Official open-data collection", source.dataset));
    card.append(paragraph);
  }
  const summary = summarize(inspections);
  if (data.county === "sc") {
    const routine = data.latestRoutineInspection;
    card.append(element("h3", "Official numerical score"));
    if (routine) {
      card.append(element("p", routine.score == null ? "Official score: not provided for the most recent routine inspection" : `Official score: ${routine.score}`));
      card.append(element("p", `Most recent routine inspection · ${routine.date}`, "hint"));
      card.append(link("Routine inspection source", routine.url));
    } else {
      card.append(element("p", "Official score: unavailable; no routine inspection was returned by the county."));
    }
  }
  if (summary.latest) {
    card.append(element("h3", "Latest available inspection"));
    card.append(element("p", `${summary.latest.date} · ${summary.latest.type || "Type not provided"}`));
    if (data.county !== "sc") {
      card.append(element("p", summary.latest.score == null ? "Official numerical score: not provided" : `Official score: ${summary.latest.score}`));
    }
    if (summary.latest.result) card.append(element("p", `Official result: ${summary.latest.result}`));
    if (summary.latest.violationCount) card.append(element("p", `County-reported violation count: ${summary.latest.violationCount}`));
    if (summary.latest.retrievedViolationCount !== undefined) card.append(element("p", `Retrieved violation entries: ${summary.latest.retrievedViolationCount}`));
    if (summary.latest.openViolationCount !== undefined && summary.latest.openViolationCount !== "") {
      card.append(element("p", `County-reported open violations: ${summary.latest.openViolationCount} (not total cited violations)`));
    }
  }
  card.append(element("h3", "Retrieved history summary"));
  for (const statement of summary.statements) card.append(element("p", statement));
  $("results").append(card);

  if (!inspections.length) return;
  const timeline = element("section", undefined, "card");
  timeline.append(element("h2", "Inspection timeline"));
  for (const inspection of inspections) {
    const details = element("details");
    details.append(element("summary", `${inspection.date} · ${inspection.type || "Inspection"}`));
    if (inspection.score != null) details.append(element("p", `Official score: ${inspection.score}`));
    if (inspection.result) details.append(element("p", `Official result: ${inspection.result}`));
    if (inspection.violationCount) details.append(element("p", `County-reported violation count: ${inspection.violationCount}`));
    if (inspection.retrievedViolationCount !== undefined) details.append(element("p", `Retrieved violation entries: ${inspection.retrievedViolationCount}`));
    if (inspection.openViolationCount !== undefined && inspection.openViolationCount !== "") {
      details.append(element("p", `County-reported open violations: ${inspection.openViolationCount} (not total cited violations)`));
    }
    if (inspection.violationText) details.append(element("p", inspection.violationText));
    if (inspection.violations.length) {
      const list = element("ul");
      for (const violation of inspection.violations) {
        const item = element("li", `${violation.severity ? `${violation.severity}: ` : ""}${violation.description || "Category not provided"}`);
        if (violation.comment) item.append(element("p", violation.comment));
        if (violation.complianceDueDate) item.append(element("p", `Compliance due date: ${violation.complianceDueDate}`, "hint"));
        if (violation.compliedOnDate) item.append(element("p", `County-recorded complied-on date: ${violation.compliedOnDate}`, "hint"));
        list.append(item);
      }
      details.append(list);
    } else if (!inspection.violationText) details.append(element("p", "No violation details in the retrieved entry. Consult the official report."));
    if (inspection.notes) details.append(element("p", `Inspector notes: ${inspection.notes}`));
    if (inspection.fieldReadings?.length) {
      details.append(element("h3", "Field readings"));
      const readings = element("ul");
      for (const reading of inspection.fieldReadings) {
        readings.append(element("li", `${reading.description || "Description not provided"}: ${reading.measurement || "Measurement not provided"}`));
      }
      details.append(readings);
    }
    if (inspection.suspensionNotes) details.append(element("p", `Suspension notes: ${inspection.suspensionNotes}`));
    if (inspection.dataAsOf) details.append(element("p", `This record's data as of: ${inspection.dataAsOf.slice(0, 10)}`, "hint"));
    details.append(link(inspection.sourceLabel || "Official source for this record", inspection.url || source.url));
    if (inspection.violationsUrl) {
      const paragraph = element("p");
      paragraph.append(link("Official violation entries", inspection.violationsUrl));
      details.append(paragraph);
    }
    timeline.append(details);
  }
  $("results").append(timeline);
}

function render(data) {
  $("results").replaceChildren();
  $("status").replaceChildren();
  needsAttention = data.kind !== "records";
  if (data.kind === "records") {
    renderCompact(data);
    return renderRecord(data);
  }
  status(data.message);
  $("record-details").open = true;
  if (data.url) $("results").append(link("Search official county records", data.url));
  if (data.kind === "candidates") {
    for (const candidate of data.candidates) $("results").append(candidateButton(candidate));
  }
}

async function runLookup(candidateKey) {
  const version = ++requestVersion;
  needsAttention = false;
  retryCandidateKey = candidateKey;
  $("results").replaceChildren();
  $("retry").hidden = true;
  if (!place) {
    status("Select a restaurant or food venue in Google Maps with its category and address visible. Non-food places and unknown categories are skipped. If Maps was already open when you installed the extension, reload that tab.");
    return;
  }
  if (!$("county").value) {
    needsAttention = true;
    status("Choose the restaurant's county using the selector below.");
    $("record-details").open = true;
    return;
  }
  status($("county").value === "sm"
    ? "Looking up official San Mateo records... A county portal tab is opened or reused in the background. Leave that tab open while records load."
    : "Looking up official inspection records...", "loading");
  try {
    const response = await chrome.runtime.sendMessage({
      type: candidateKey ? "LOAD_FACILITY" : "LOOKUP",
      county: $("county").value,
      place,
      candidateKey,
    });
    if (version !== requestVersion) return;
    if (!response?.ok) throw new Error(response?.error || "The extension did not return a lookup response.");
    render(response.data);
  } catch (error) {
    if (version !== requestVersion) return;
    needsAttention = true;
    status(`Lookup failed: ${error.message}`, "notice error");
    $("retry").hidden = false;
    $("record-details").open = true;
  }
}

function setPlace(next) {
  if (selectionInitialized && place?.key === next?.key) return;
  selectionInitialized = true;
  place = next;
  if (embedded && displayMode === "inline") $("record-details").open = false;
  $("place").hidden = !place;
  $("jurisdiction").hidden = !place;
  $("place-name").textContent = place?.name || "";
  $("place-address").textContent = place?.address || "";
  if (place) {
    // The content script only publishes places already matched to a supported county.
    const county = place.county;
    $("county").value = county || "";
    $("county-detection").textContent = county
      ? `${COUNTIES[county].name} · detected automatically from Google Maps`
      : "County could not be determined from this Maps address. Choose a supported county below.";
    $("county-override").open = !county;
  }
  void runLookup();
}

let tabVersion = 0;
async function readTabPlace(tabId) {
  const version = contextVersion;
  const request = ++readVersion;
  const response = await chrome.runtime.sendMessage({ type: "READ_SELECTED_PLACE", tabId });
  if (!response?.ok) throw new Error(response?.error || "Cannot read the selected Maps restaurant.");
  if (tabId === activeTabId && version === contextVersion && request === readVersion) setPlace(response.context);
}

async function refreshTab() {
  const version = ++tabVersion;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (version !== tabVersion) return;
    activeTabId = tab?.id;
    setPlace(null);
    if (!activeTabId) return;
    await readTabPlace(activeTabId);
  } catch (error) {
    if (version === tabVersion) status(`Unable to read the selected tab: ${error.message}`, "notice error");
  }
}

$("county").addEventListener("change", () => {
  const county = COUNTIES[$("county").value];
  $("county-detection").textContent = county
    ? `${county.name} · selected manually for this restaurant`
    : "Choose a supported county to load records.";
  void runLookup();
});
$("retry").addEventListener("click", () => void runLookup(retryCandidateKey));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[`place:${activeTabId}`]) {
    contextVersion++;
    setPlace(changes[`place:${activeTabId}`].newValue || null);
  }
});
chrome.tabs.onActivated.addListener(info => {
  if (!embedded && info.windowId === windowId) void refreshTab();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== activeTabId || !["loading", "complete"].includes(change.status)) return;
  const version = contextVersion;
  void readTabPlace(tabId).catch(error => {
    if (tabId === activeTabId && version === contextVersion) {
      status(`Unable to refresh the selected Maps place: ${error.message}`, "notice error");
    }
  });
});
renderSources();
status("Connecting to the selected Google Maps place...", "loading");
try {
  if (embedded) {
    const response = await chrome.runtime.sendMessage({ type: "PANEL_TAB" });
    if (!response?.ok || !Number.isInteger(response.tabId)) throw new Error(response?.error || "Cannot identify the Maps tab.");
    activeTabId = response.tabId;
    await readTabPlace(activeTabId);
  } else {
    windowId = (await chrome.windows.getCurrent()).id;
    await refreshTab();
  }
} catch (error) {
  status(`Unable to initialize the sidebar: ${error.message}`, "notice error");
}
