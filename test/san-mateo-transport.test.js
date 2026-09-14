import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createSanMateoTransport } from "../lib/san-mateo-transport.js";
import { fetchText } from "../lib/http.js";

const search = "https://smcehs.my.site.com/s/inspection-report-search?language=en_US";
const endpoint = "https://smcehs.my.site.com/s/sfsites/aura?r=1&aura.ApexAction.execute=1";
const validate = globalThis.HealthInspectSanMateoRequest.validate;
function actionBody(method = "getInspectionRecordList", params = { blaId: "facility-fixture" }) {
  return new URLSearchParams({
    message: JSON.stringify({ actions: [{
      id: "1;a", descriptor: "aura://ApexActionController/ACTION$execute", callingDescriptor: "UNKNOWN",
      params: { namespace: "", classname: "smcehs_InspectionReportSearchHandler",
        method, params, cacheable: false, isContinuation: false },
    }] }),
    "aura.context": JSON.stringify({ mode: "PROD", app: "siteforce:communityApp", fwuid: "fixture" }),
    "aura.pageURI": "/s/inspection-report-search?language=en_US", "aura.token": "null",
  }).toString();
}

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].forEach(listener => listener(...args)),
    size: () => listeners.size,
  };
}

function portalMock(existing = false) {
  const tab = { id: 25, url: search, status: "complete" };
  const tabs = existing ? [tab] : [];
  const created = [], injected = [], sent = [];
  const api = {
    tabs: {
      query: async query => {
        assert.equal(query.url, "https://smcehs.my.site.com/s/inspection-report-search*");
        return [...tabs];
      },
      create: async options => { created.push(options); tabs.push(tab); return tab; },
      get: async id => { assert.equal(id, tab.id); return tab; },
      onUpdated: event(), onRemoved: event(),
      sendMessage: async (id, message, target) => {
        sent.push({ id, message, target });
        return { ok: true, status: 200, body: "public fixture response" };
      },
    },
    scripting: { executeScript: async options => {
      injected.push(options);
      return [{ frameId: 0, documentId: `document-${injected.length}` }];
    } },
  };
  return { api, tab, created, injected, sent };
}

test("the county bridge permits only bounded, anonymous read actions on the official host", () => {
  assert.equal(validate({ url: search, method: "GET" }).url, search);
  for (const [method, params] of [
    ["getBlaRecordList", { fN: "Fixture's Cafe", fS: "", fC: "", bN: "", vR: "" }],
    ["getInspectionRecordList", { blaId: "facility-fixture" }],
    ["getViolationRecordList", { visitRecId: "visit-fixture" }],
    ["getFieldReadingRecordList", { visitRecId: "visit-fixture" }],
  ]) assert.equal(validate({ url: endpoint, method: "POST", body: actionBody(method, params) }).method, "POST");
  for (const request of [
    { url: "https://example.org/s/inspection-report-search", method: "GET" },
    { url: "http://smcehs.my.site.com/s/inspection-report-search", method: "GET" },
    { url: `${search}&redirect=https://example.org`, method: "GET" },
    { url: search, method: "DELETE" },
    { url: `${endpoint}&other.action=1`, method: "POST", body: actionBody() },
    { url: endpoint, method: "POST", body: actionBody("deleteRecord") },
    { url: endpoint, method: "POST", body: actionBody("getBlaRecordList", { fN: "", fS: "", fC: "", bN: "", vR: "" }) },
    { url: endpoint, method: "POST", body: actionBody().replace("aura.token=null", "aura.token=private-token-fixture") },
    { url: endpoint, method: "POST", body: `${actionBody()}&aura.token=null` },
  ]) assert.throws(() => validate(request));
  const form = new URLSearchParams(actionBody());
  const message = JSON.parse(form.get("message"));
  message.actions[0].params.classname = "UnapprovedHandler";
  form.set("message", JSON.stringify(message));
  assert.throws(() => validate({ url: endpoint, method: "POST", body: form.toString() }), /read-only/);
});

test("concurrent reads share one inactive portal tab, then reuse it and target the injected document", async () => {
  const mock = portalMock();
  const transport = createSanMateoTransport(mock.api);
  const responses = await Promise.all([transport(search), transport(search)]);
  assert.equal(await responses[0].text(), "public fixture response");
  assert.equal(mock.created.length, 1);
  assert.deepEqual(mock.created[0], { url: search, active: false });
  assert.equal(mock.injected.length, 1);
  assert.deepEqual(mock.injected[0].files, ["lib/san-mateo-request.js", "san-mateo-bridge.js"]);
  assert.deepEqual(mock.sent[0].target, { documentId: "document-1" });
  await transport(endpoint, { method: "POST", body: actionBody() });
  assert.equal(mock.created.length, 1);
  assert.equal(mock.injected.length, 2);
  assert.deepEqual(mock.sent.at(-1).target, { documentId: "document-2" });
});

test("an existing portal is reused without reloading or navigating it", async () => {
  const mock = portalMock(true);
  await createSanMateoTransport(mock.api)(search);
  assert.equal(mock.created.length, 0);
  assert.equal(mock.sent[0].id, mock.tab.id);
});

test("new portal loading waits for completion and removes event listeners", async () => {
  const mock = portalMock();
  mock.tab.status = "loading";
  const response = createSanMateoTransport(mock.api)(search);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.api.tabs.onUpdated.size(), 1);
  assert.equal(mock.sent.length, 0);
  mock.tab.status = "complete";
  mock.api.tabs.onUpdated.emit(mock.tab.id, { status: "complete" }, mock.tab);
  await response;
  assert.equal(mock.api.tabs.onUpdated.size(), 0);
  assert.equal(mock.api.tabs.onRemoved.size(), 0);
});

test("closed, redirected, inaccessible, and unresponsive portal documents fail explicitly", async () => {
  const closed = portalMock();
  closed.tab.status = "loading";
  const pending = createSanMateoTransport(closed.api)(search);
  const failure = assert.rejects(pending, /portal tab was closed/);
  await new Promise(resolve => setImmediate(resolve));
  closed.api.tabs.onRemoved.emit(closed.tab.id);
  await failure;
  assert.equal(closed.api.tabs.onUpdated.size(), 0);
  assert.equal(closed.sent.length, 0);

  const redirected = portalMock(true);
  redirected.tab.url = "https://example.org/";
  await assert.rejects(createSanMateoTransport(redirected.api)(search), /navigated away/);
  assert.equal(redirected.injected.length, 0);

  const inaccessible = portalMock(true);
  inaccessible.api.scripting.executeScript = async () => { throw new Error("Permission denied by browser policy"); };
  await assert.rejects(fetchText(search, { fetchImpl: createSanMateoTransport(inaccessible.api) }), /Permission denied by browser policy/);

  const absent = portalMock(true);
  absent.api.tabs.sendMessage = async () => undefined;
  await assert.rejects(createSanMateoTransport(absent.api)(search), /portal did not respond/);
});

test("invalid or already-cancelled requests cannot open a county tab", async () => {
  const mock = portalMock();
  const transport = createSanMateoTransport(mock.api);
  await assert.rejects(transport("https://example.org/"), /Unsupported San Mateo/);
  await assert.rejects(transport(search, { signal: AbortSignal.abort(new DOMException("Cancelled", "AbortError")) }), /Cancelled/);
  assert.equal(mock.created.length, 0);
  assert.equal(mock.injected.length, 0);
});

test("the injected bridge uses real same-origin fetches, omits cookies, and rejects non-background senders", async () => {
  const [validator, bridge] = await Promise.all([
    readFile(new URL("../lib/san-mateo-request.js", import.meta.url), "utf8"),
    readFile(new URL("../san-mateo-bridge.js", import.meta.url), "utf8"),
  ]);
  const messages = event();
  let listener;
  const calls = [];
  const sandbox = {
    URL, URLSearchParams, AbortSignal, location: { origin: "https://smcehs.my.site.com" },
    chrome: { runtime: { id: "extension-fixture", onMessage: {
      addListener: value => { listener = value; messages.addListener(value); },
      removeListener: value => messages.removeListener(value),
    } } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response("public fixture JSON", { status: 200 });
    },
  };
  vm.runInNewContext(validator, sandbox);
  vm.runInNewContext(bridge, sandbox);
  const request = { type: "SM_PUBLIC_FETCH", request: { url: endpoint, method: "POST", body: actionBody() } };
  const response = await new Promise(resolve => {
    assert.equal(listener(request, { id: "extension-fixture" }, resolve), true);
  });
  assert.equal(response.body, "public fixture JSON");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers.Origin, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const sender of [{ id: "another-extension" }, { id: "extension-fixture", tab: { id: 1 } }]) {
    const denied = await new Promise(resolve => listener(request, sender, resolve));
    assert.equal(denied.ok, false);
  }
  assert.equal(calls.length, 1);
  vm.runInNewContext(bridge, sandbox);
  assert.equal(messages.size(), 1, "Re-injection must replace the listener, not duplicate it.");
  sandbox.location.origin = "https://example.org";
  assert.throws(() => vm.runInNewContext(bridge, sandbox), /requires the official county page/);
});
