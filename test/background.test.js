import test from "node:test";
import assert from "node:assert/strict";

let listener;
const stored = [];
const storageData = {};
const routed = [];
let frameResponse = null;
const tabUpdates = [];
let tabRemoved;
const extensionId = "test-extension";
const getURL = path => `chrome-extension://${extensionId}/${path}`;
globalThis.chrome = {
  runtime: {
    id: extensionId, getURL,
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: callback => { listener = callback; } },
  },
  tabs: {
    onRemoved: { addListener: callback => { tabRemoved = callback; } },
    onUpdated: { addListener: callback => { tabUpdates.push(callback); } },
    sendMessage: async (tabId, message, target) => {
      routed.push({ tabId, message, target });
      return frameResponse;
    },
  },
  storage: { session: {
    set: async value => { stored.push(value); Object.assign(storageData, value); },
    get: async key => ({ [key]: storageData[key] }),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key]; },
  } },
};
await import("../background.js");

test("selection messages acknowledge Maps entry URLs, including bare paths and queries", async () => {
  for (const url of [
    "https://www.google.com/maps",
    "https://www.google.com/maps?entry=ttu",
    "https://www.google.com/maps/",
    "https://www.google.com/maps/place/Fixture/",
    "https://maps.google.com/",
    "https://maps.google.com/?q=restaurant",
  ]) {
    const response = await new Promise(resolve => {
      const keepAlive = listener({ type: "MAP_CONTEXT", context: null }, {
        id: extensionId, url, tab: { id: 37 }, frameId: 0,
      }, resolve);
      assert.equal(keepAlive, true, url);
    });
    assert.deepEqual(response, { ok: true }, url);
    assert.deepEqual(stored.at(-1), { "place:37": null, "maps-source:37": { frameId: 0 } });
  }
});

test("unsupported selection senders get an explicit rejection, never an empty reply", () => {
  for (const sender of [
    { url: "https://www.google.com/maps", tab: { id: 37 }, frameId: -1 },
    { url: "https://www.google.com/maps", tab: { id: 37 } },
    { url: "https://www.google.com/maps", frameId: 0 },
    { url: "https://www.google.com/maps-other", tab: { id: 37 }, frameId: 0 },
    { url: "https://evil.test/maps/", tab: { id: 37 }, frameId: 0 },
    { url: "http://maps.google.com/", tab: { id: 37 }, frameId: 0 },
    { url: "bad-url", tab: { id: 37 }, frameId: 0 },
  ]) {
    let response;
    listener({ type: "MAP_CONTEXT", context: null }, { id: extensionId, ...sender }, value => { response = value; });
    assert.equal(response.ok, false);
    assert.ok(response.error.length > 0);
  }
});

test("an embedded panel is bound to its sender tab, not the active tab", () => {
  let response;
  listener({ type: "PANEL_TAB" }, {
    id: extensionId, url: getURL("sidepanel.html?embedded=1"), tab: { id: 37 }, frameId: 4,
  }, value => { response = value; });
  assert.deepEqual(response, { ok: true, tabId: 37 });
});

test("ordinary pages cannot obtain a panel tab binding", () => {
  let response;
  listener({ type: "PANEL_TAB" }, {
    id: extensionId, url: "https://www.google.com/maps/", tab: { id: 37 }, frameId: 0,
  }, value => { response = value; });
  assert.equal(response, undefined);
});

test("panels without a containing tab receive explicit binding errors", () => {
  for (const sender of [
    { url: getURL("sidepanel.html?embedded=1"), frameId: 0 },
    { url: getURL("sidepanel.html"), frameId: 0 },
  ]) {
    let response;
    listener({ type: "PANEL_TAB" }, { id: extensionId, ...sender }, value => { response = value; });
    assert.equal(response.ok, false);
    assert.match(response.error, /not attached/);
  }
});

test("Maps frame 97854 is accepted and panel reads target that frame", async () => {
  const place = { name: "Fixture Cafe", address: "123 Main St, San Francisco, CA", category: "Cafe", key: "fixture" };
  const sender = { id: extensionId, url: "https://www.google.com/maps/place/Fixture/", tab: { id: 42 }, frameId: 97854 };
  const acknowledgement = await new Promise(resolve => listener({ type: "MAP_CONTEXT", context: place }, sender, resolve));
  assert.deepEqual(acknowledgement, { ok: true });
  assert.deepEqual(storageData["maps-source:42"], { frameId: 97854 });
  frameResponse = place;
  const response = await new Promise(resolve => listener({ type: "READ_SELECTED_PLACE", tabId: 42 }, {
    id: extensionId, url: getURL("sidepanel.html?embedded=1"), tab: { id: 42 }, frameId: 98765,
  }, resolve));
  assert.deepEqual(response, { ok: true, context: place });
  assert.deepEqual(routed.at(-1), { tabId: 42, message: { type: "READ_MAP_CONTEXT" }, target: { frameId: 97854 } });
});

test("native sidebar reads target the recorded document instead of assuming frame zero", async () => {
  const sender = {
    id: extensionId, url: "https://www.google.com/maps", tab: { id: 43 },
    frameId: 97854, documentId: "maps-document-fixture",
  };
  await new Promise(resolve => listener({ type: "MAP_CONTEXT", context: null }, sender, resolve));
  frameResponse = null;
  const response = await new Promise(resolve => listener({ type: "READ_SELECTED_PLACE", tabId: 43 }, {
    id: extensionId, url: getURL("sidepanel.html"),
  }, resolve));
  assert.deepEqual(response, { ok: true, context: null });
  assert.deepEqual(routed.at(-1).target, { documentId: "maps-document-fixture" });
});

test("embedded panels cannot read a different tab and absent source mappings do not guess", async () => {
  let response;
  listener({ type: "READ_SELECTED_PLACE", tabId: 43 }, {
    id: extensionId, url: getURL("sidepanel.html?embedded=1"), tab: { id: 42 }, frameId: 9,
  }, value => { response = value; });
  assert.equal(response.ok, false);
  const reads = routed.length;
  const empty = await new Promise(resolve => listener({ type: "READ_SELECTED_PLACE", tabId: 999 }, {
    id: extensionId, url: getURL("sidepanel.html"),
  }, resolve));
  assert.deepEqual(empty, { ok: true, context: null });
  assert.equal(routed.length, reads);
});

test("embedded frame loading cannot erase a valid Maps binding; tab closure still clears it", async () => {
  const place = { name: "Fixture Cafe", address: "123 Main St, San Francisco, CA", category: "Cafe", key: "loading-fixture" };
  await new Promise(resolve => listener({ type: "MAP_CONTEXT", context: place }, {
    id: extensionId, url: "https://www.google.com/maps/place/Fixture/", tab: { id: 44 }, frameId: 97854,
  }, resolve));
  for (const callback of tabUpdates) callback(44, { status: "loading" });
  await Promise.resolve();
  assert.equal(storageData["place:44"].key, place.key);
  assert.deepEqual(storageData["maps-source:44"], { frameId: 97854 });
  frameResponse = place;
  const response = await new Promise(resolve => listener({ type: "READ_SELECTED_PLACE", tabId: 44 }, {
    id: extensionId, url: getURL("sidepanel.html"),
  }, resolve));
  assert.equal(response.context.key, place.key);
  tabRemoved(44);
  await Promise.resolve();
  assert.equal(storageData["place:44"], undefined);
  assert.equal(storageData["maps-source:44"], undefined);
});

test("both lookup operations reject non-food places before calling a county provider", async t => {
  const errors = t.mock.method(console, "error", () => {});
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network request"); };
  try {
    for (const type of ["LOOKUP", "LOAD_FACILITY"]) {
      const response = await new Promise(resolve => listener({
        type, county: "sf", candidateKey: "fixture",
        place: { name: "Fixture Restaurant Supplies", address: "1 Main St, San Francisco, CA", category: "Restaurant supply store", key: "supply" },
      }, { id: extensionId, url: getURL("sidepanel.html") }, resolve));
      assert.equal(response.ok, false);
      assert.match(response.error, /categories are skipped/);
    }
    assert.equal(requests, 0);
    assert.equal(errors.mock.callCount(), 2);
  } finally { globalThis.fetch = originalFetch; }
});
