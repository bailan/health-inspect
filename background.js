import { lookup, loadFacility } from "./lib/sources.js";
import { createSanMateoTransport } from "./lib/san-mateo-transport.js";
import "./lib/maps-context.js";

let sanMateoFetch;
const contextKey = tabId => `place:${tabId}`;
const sourceKey = tabId => `maps-source:${tabId}`;
function isMaps(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === "https:" && (url.hostname === "maps.google.com"
    || (url.hostname === "www.google.com" && (url.pathname === "/maps" || url.pathname.startsWith("/maps/"))));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(error => console.error("[Health Inspect] Cannot configure side panel:", error));
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove([contextKey(tabId), sourceKey(tabId)])
    .catch(error => console.error("[Health Inspect] Cannot clear closed tab:", error));
});

function validPlace(place) {
  return place && typeof place.name === "string" && place.name.length > 0 && place.name.length <= 250
    && typeof place.address === "string" && place.address.length > 0 && place.address.length <= 500
    && typeof place.key === "string" && place.key.length <= 800
    && globalThis.HealthInspectMaps.isFoodCategory(place.category);
}

async function readSelectedPlace(tabId) {
  const stored = await chrome.storage.session.get(sourceKey(tabId));
  const source = stored[sourceKey(tabId)];
  if (!source) return null;
  // Document IDs avoid sending a read to a different document that reuses a frame.
  const target = source.documentId ? { documentId: source.documentId } : { frameId: source.frameId };
  let context;
  try {
    context = await chrome.tabs.sendMessage(tabId, { type: "READ_MAP_CONTEXT" }, target);
  } catch (error) {
    if (/Receiving end does not exist|Could not establish connection/.test(error.message)) return null;
    throw error;
  }
  if (context !== null && !validPlace(context)) {
    throw new Error("The Maps document did not return valid restaurant details. Reload Maps and retry.");
  }
  return context;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || sender.id !== chrome.runtime.id) return;
  if (message.type === "MAP_CONTEXT") {
    if (!sender.tab || !Number.isInteger(sender.frameId) || sender.frameId < 0) {
      respond({ ok: false, error: "Selection messages must identify a Google Maps tab and frame." });
      return;
    }
    if (!isMaps(sender.url)) {
      respond({ ok: false, error: "The selection message did not originate from a supported Google Maps page. Reload a www.google.com/maps or maps.google.com tab." });
      return;
    }
    if (message.context !== null && !validPlace(message.context)) {
      respond({ ok: false, error: "Invalid restaurant details from Maps." });
      return;
    }
    const source = {
      frameId: sender.frameId,
      ...(typeof sender.documentId === "string" && sender.documentId ? { documentId: sender.documentId } : {}),
    };
    chrome.storage.session.set({
      [contextKey(sender.tab.id)]: message.context,
      [sourceKey(sender.tab.id)]: source,
    })
      .then(() => respond({ ok: true }))
      .catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  const embedded = sender.url === chrome.runtime.getURL("sidepanel.html?embedded=1");
  if (!embedded && sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
  if (message.type === "PANEL_TAB") {
    if (!embedded || !sender.tab) {
      respond({ ok: false, error: "The in-page panel is not attached to a Maps tab." });
    } else respond({ ok: true, tabId: sender.tab.id });
    return;
  }
  if (message.type === "READ_SELECTED_PLACE") {
    if (!Number.isInteger(message.tabId) || message.tabId < 0 || (embedded && sender.tab?.id !== message.tabId)) {
      respond({ ok: false, error: "The panel cannot read a selection from that tab." });
      return;
    }
    readSelectedPlace(message.tabId)
      .then(context => respond({ ok: true, context }))
      .catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (!["LOOKUP", "LOAD_FACILITY"].includes(message.type)) return;
  (async () => {
    if (!validPlace(message.place)) throw new Error("Select a restaurant or food venue with a visible category and street address in Google Maps. Other or unknown categories are skipped.");
    const options = message.county === "sm" ? { fetchImpl: sanMateoFetch ||= createSanMateoTransport(chrome) } : {};
    if (message.type === "LOOKUP") return lookup(message.county, message.place, options);
    return loadFacility(message.county, message.candidateKey, message.place, options);
  })().then(data => respond({ ok: true, data }))
    .catch(error => {
      console.error("[Health Inspect] Lookup failed:", error);
      respond({ ok: false, error: error.message || "The inspection source could not be reached." });
    });
  return true;
});
