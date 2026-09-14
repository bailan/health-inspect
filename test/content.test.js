import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const parser = await readFile(new URL("../lib/maps-context.js", import.meta.url), "utf8");
const script = await readFile(new URL("../content.js", import.meta.url), "utf8");

function harness({ sendMessage = async () => ({ ok: true }) } = {}) {
  const state = { name: "First Cafe", address: "Address: 1 Main St, San Francisco, CA", category: "Cafe", observer: null, interval: null, messages: [], panels: [], panelErrors: [], logs: [], timers: new Map(), lifecycle: {}, disconnected: false, intervalStopped: false };
  let nextTimer = 0;
  const context = vm.createContext({
    URL, console: { warn: (...args) => state.logs.push(["warn", ...args]), info: (...args) => state.logs.push(["info", ...args]) },
    HealthInspectPanel: { update: place => state.panels.push(place), error: message => state.panelErrors.push(message) },
    addEventListener: (name, callback) => { state.lifecycle[name] = callback; },
    removeEventListener: name => { delete state.lifecycle[name]; },
    location: { href: "https://www.google.com/maps/place/First+Cafe/" },
    document: {
      body: {},
      querySelector: selector => selector.includes("address")
        ? { getAttribute: () => state.address, textContent: state.address }
        : { textContent: selector.includes("category") ? state.category : state.name },
    },
    MutationObserver: class {
      constructor(callback) { state.observer = callback; }
      observe() {}
      disconnect() { state.disconnected = true; }
    },
    setTimeout: callback => { state.timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => state.timers.delete(id),
    setInterval: callback => { state.interval = callback; return 1; },
    clearInterval: () => { state.intervalStopped = true; },
    chrome: { runtime: {
      id: "test-extension",
      sendMessage: async message => { state.messages.push(message); return sendMessage(message); },
      onMessage: { addListener: callback => { state.reader = callback; } },
    } },
  });
  vm.runInContext(parser, context);
  vm.runInContext(script, context);
  async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    const timers = [...state.timers.values()];
    state.timers.clear();
    for (const callback of timers) callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  return { state, context, settle };
}

test("content script clears old details before publishing the next stable selection", async () => {
  const { state, context, settle } = harness();
  await settle();
  assert.equal(state.messages.at(-1).context.name, "First Cafe");
  assert.equal(state.panels.at(-1).name, "First Cafe");
  context.location.href = "https://www.google.com/maps/place/Second+Cafe/";
  state.interval();
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  assert.equal(state.panels.at(-1), null);
  state.name = "Second Cafe";
  state.address = "Address: 2 Main St, San Francisco, CA";
  state.observer();
  await settle();
  assert.equal(state.messages.at(-1).context.name, "Second Cafe");
  assert.equal(state.panels.at(-1).name, "Second Cafe");
  assert.match(state.messages.at(-1).context.address, /^2 Main/);
});

test("unrelated mutations do not trigger additional lookups", async () => {
  const { state, settle } = harness();
  await settle();
  const count = state.messages.length;
  state.observer();
  state.observer();
  await settle();
  assert.equal(state.messages.length, count);
});

test("non-food and missing categories clear records without publishing an eligible place", async () => {
  const { state, settle } = harness();
  await settle();
  const published = state.messages.filter(message => message.context).length;
  state.category = "Restaurant supply store";
  state.observer();
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  assert.equal(state.panels.at(-1), null);
  state.category = "";
  state.observer();
  await settle();
  assert.equal(state.messages.filter(message => message.context).length, published);
  state.category = "Bakery";
  state.observer();
  await settle();
  assert.equal(state.messages.at(-1).context.category, "Bakery");
});

test("continuous mutations do not starve a stable pending place", async () => {
  const { state, settle } = harness();
  const originalTimer = [...state.timers.keys()][0];
  state.observer();
  state.observer();
  assert.equal([...state.timers.keys()][0], originalTimer);
  await settle();
  assert.equal(state.messages.at(-1).context.name, "First Cafe");
});

test("the periodic probe detects late categories without a URL change or mutation callback", async () => {
  const { state, settle } = harness();
  state.category = "";
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  state.category = "Cafe";
  state.interval();
  await settle();
  assert.equal(state.messages.at(-1).context.name, "First Cafe");
  const count = state.messages.length;
  state.interval();
  await settle();
  assert.equal(state.messages.length, count);
});

test("actual page departure clears the selection and bfcache restoration republishes it", async () => {
  const { state, settle } = harness();
  await settle();
  state.lifecycle.pagehide();
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  const count = state.messages.length;
  state.interval();
  await settle();
  assert.equal(state.messages.length, count);
  let context;
  state.reader({ type: "READ_MAP_CONTEXT" }, {}, value => { context = value; });
  assert.equal(context, null);
  state.lifecycle.pageshow();
  await settle();
  assert.equal(state.messages.at(-1).context.name, "First Cafe");
});

test("same-name branch navigation waits for the old street address to change", async () => {
  const { state, context, settle } = harness();
  context.location.href = "https://www.google.com/maps/place/First+Cafe/data=!1sbranch-a!";
  await settle();
  // Reinitialize selection tracking once with the source branch token.
  state.observer();
  await settle();
  state.address = "Address: 10 Main St, San Francisco, CA";
  state.observer();
  await settle();
  assert.equal(state.messages.at(-1).context.address, "10 Main St, San Francisco, CA");
  context.location.href = "https://www.google.com/maps/place/First+Cafe/data=!1sbranch-b!";
  state.interval();
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  state.address = "Address: 20 Main St, San Francisco, CA";
  state.observer();
  await settle();
  assert.match(state.messages.at(-1).context.address, /^20 Main/);
});

test("closing a place clears the selected context", async () => {
  const { state, context, settle } = harness();
  await settle();
  context.location.href = "https://www.google.com/maps/search/restaurants";
  state.interval();
  await settle();
  assert.equal(state.messages.at(-1).context, null);
  context.location.href = "https://www.google.com/maps/place/First+Cafe/";
  state.interval();
  await settle();
  assert.equal(state.messages.at(-1).context.name, "First Cafe");
});

test("invalidated contexts stop even when runtime.id is still present", async () => {
  const { state, context, settle } = harness({
    sendMessage: async () => { throw new Error("Extension context invalidated."); },
  });
  await settle();
  assert.equal(context.chrome.runtime.id, "test-extension");
  assert.equal(state.disconnected, true);
  assert.equal(state.intervalStopped, true);
  assert.equal(state.timers.size, 0);
  assert.equal(state.messages.length, 1);
  assert.equal(state.panelErrors.length, 1);
  assert.match(state.panelErrors[0], /Reload this Maps tab.*Extension context invalidated/);
  state.observer();
  state.interval();
  await settle();
  assert.equal(state.messages.length, 1);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0][0], "info");
  let selected;
  state.reader({ type: "READ_MAP_CONTEXT" }, {}, value => { selected = value; });
  assert.equal(selected, null);
});

test("already queued publications cannot run after invalidation", async () => {
  let rejectMessage;
  const { state, settle } = harness({
    sendMessage: () => new Promise((_resolve, reject) => { rejectMessage = reject; }),
  });
  await settle();
  assert.equal(state.messages.length, 1);
  rejectMessage(new Error("Extension context invalidated."));
  await settle();
  assert.equal(state.messages.length, 1);
  assert.equal(state.panelErrors.length, 1);
});

test("non-invalidation failures retain the actual error and do not loop", async () => {
  const { state, settle } = harness({
    sendMessage: async () => ({ ok: false, error: "Session storage write failed" }),
  });
  await settle();
  assert.match(state.panelErrors[0], /sync the selected restaurant.*Session storage write failed/);
  assert.equal(state.logs[0][0], "warn");
  state.observer();
  await settle();
  assert.equal(state.messages.length, 1);
});
