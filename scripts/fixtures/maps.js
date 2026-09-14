// Synthetic local browser fixture only; never loaded by the extension manifest.
(() => {
  const invalidAtStartup = new URL(location.href).searchParams.has("simulate-invalidated");
  const places = {
    sf: ["Fixture Cafe SF", "123 Main St, San Francisco, CA 94103", "Cafe"],
    sc: ["Fixture Cafe SC", "456 First St, San Jose CA 95113", "Restaurant"],
    sm: ["Fixture Cafe SM", "789 Main St, South San Francisco, CA 94080", "Bakery"],
    unknown: ["Fixture Cafe Unknown", "1 Main St, Unknown City, CA", "Restaurant"],
    hotel: ["Fixture Hotel", "2 Main St, San Francisco, CA 94103", "Hotel"],
    supply: ["Fixture Restaurant Supplies", "3 Main St, San Francisco, CA 94103", "Restaurant supply store"],
    "no-category": ["Fixture Unknown Type", "4 Main St, San Francisco, CA 94103", ""],
  };
  window.__lookups = [];
  window.__storageListeners = [];
  window.__activationListeners = [];
  window.__frameReads = [];
  window.__updateListeners = [];
  window.__mapsBridge = {
    createChrome(view) {
      return {
        runtime: {
          id: "fixture-extension",
          getURL: path => {
            if (invalidAtStartup) throw new Error("Extension context invalidated.");
            return `${location.origin}/${path}`;
          },
          onMessage: { addListener: listener => { window.__readContext = listener; } },
          sendMessage: async message => {
            if (invalidAtStartup) throw new Error("Extension context invalidated.");
            if (message.type === "PANEL_TAB") return { ok: true, tabId: 37 };
            if (message.type === "READ_SELECTED_PLACE") {
              return { ok: true, context: await window.chrome.tabs.sendMessage(
                message.tabId, { type: "READ_MAP_CONTEXT" }, { frameId: 97854 },
              ) };
            }
            if (message.type === "MAP_CONTEXT") {
              for (const listener of window.__storageListeners) {
                listener({ "place:37": { newValue: message.context } }, "session");
              }
              return { ok: true };
            }
            if (message.type === "LOOKUP" || message.type === "LOAD_FACILITY") {
              window.__lookups.push(message);
              if (window.__nextLookupResponse) {
                const response = window.__nextLookupResponse;
                delete window.__nextLookupResponse;
                return response;
              }
              return { ok: true, data: {
                kind: "records", county: message.county,
                facility: { id: "fixture", name: message.place.name, address: message.place.address, exactMatch: false, candidateKey: "sole" },
                candidates: [{ id: "fixture", name: message.place.name, address: message.place.address, candidateKey: "sole" }],
                source: { url: "https://example.org/fixture", retrievedAt: "2026-01-01T00:00:00Z" },
                ...(message.county === "sc" ? {
                  latestRoutineInspection: { date: "2025-01-01", type: "ROUTINE INSPECTION", score: 95, url: "https://example.org/routine-fixture" },
                  inspections: [{ date: "2025-02-01", type: "REINSPECTION", score: null, result: "Pass (Green)", violations: [] }],
                } : message.county === "sm" ? {
                  inspections: [{
                    date: "2026-01-26", type: "", score: null, result: "Pass",
                    openViolationCount: "0", retrievedViolationCount: 1,
                    notes: "Synthetic inspector notes.",
                    violations: [{ description: "Synthetic cooling citation", comment: "Corrected on site.",
                      compliedOnDate: "2026-01-26", complianceDueDate: "2026-02-25" }],
                    fieldReadings: [{ description: "Synthetic sink reading", measurement: "100 DEGREES F." }],
                    sourceLabel: "County inspection history - visit FIXTURE",
                  }],
                } : { inspections: [{ date: "2025-01-01", type: "Routine", score: 95, violations: [] }] }),
              } };
            }
            throw new Error(`Unexpected fixture message: ${message.type}`);
          },
        },
        tabs: {
          query: async () => { throw new Error("Embedded panels must not read whichever tab is active."); },
          sendMessage: async (tabId, message, options) => {
            if (tabId !== 37 || options.frameId !== 97854) throw new Error("Wrong Maps tab or frame.");
            window.__frameReads.push(options.frameId);
            let result;
            window.__readContext(message, {}, context => { result = context; });
            return result;
          },
          onActivated: { addListener: listener => window.__activationListeners.push(listener) },
          onUpdated: { addListener: listener => window.__updateListeners.push(listener) },
        },
        windows: { getCurrent: async () => { throw new Error("Embedded panel must bind to its containing tab."); } },
        storage: {
          local: {
            get: async key => ({ [key]: localStorage.getItem(`fixture-${key}`) ?? undefined }),
            set: async values => {
              if (window.__failDisplaySave) throw new Error("Fixture preference write failed");
              const changes = {};
              for (const [key, value] of Object.entries(values)) {
                changes[key] = { newValue: value };
                localStorage.setItem(`fixture-${key}`, value);
              }
              for (const listener of window.__storageListeners) listener(changes, "local");
            },
          },
          onChanged: { addListener: listener => {
          window.__storageListeners.push((changes, area) => {
            if (view === window || (view.frameElement?.isConnected && view.frameElement.src.includes("embedded=1"))) listener(changes, area);
          });
        } } },
      };
    },
  };
  window.chrome = window.__mapsBridge.createChrome(window);
  const parse = window.HealthInspectMaps.contextFromSnapshot;
  window.HealthInspectMaps.contextFromSnapshot = snapshot => parse({
    ...snapshot, url: snapshot.url.replace(location.origin, "https://www.google.com"),
  });
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = attachShadow.call(this, options);
    if (this.id === "health-inspect-panel") window.__panelRoot = root;
    return root;
  };
  function select(id) {
    const [name, address, category] = places[id];
    history.pushState(null, "", `/maps/place/${encodeURIComponent(name)}/data=!1s${id}!`);
    document.querySelector("h1").textContent = name;
    document.querySelector('[data-item-id="address"]').setAttribute("aria-label", `Address: ${address}`);
    document.querySelector(".DkEaL").textContent = category;
  }
  for (const id of Object.keys(places)) document.getElementById(`select-${id}`).addEventListener("click", () => select(id));
  document.getElementById("clear-place").addEventListener("click", () => {
    history.pushState(null, "", "/maps/search/restaurants");
    document.querySelector("h1").textContent = "";
    document.querySelector('[data-item-id="address"]').removeAttribute("aria-label");
  });
  select("sf");
})();
