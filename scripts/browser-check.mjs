import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Browser fixtures are deliberately separate from the extension's data sources.
const root = new URL("../", import.meta.url);
const profile = await mkdtemp(join(tmpdir(), "health-inspect-browser-test-"));
let browser;
let socket;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path.startsWith("/maps/")) {
      response.setHeader("Content-Type", "text/html");
      response.end(await readFile(new URL("scripts/fixtures/maps.html", root)));
      return;
    }
    const allowed = /^\/(sidepanel\.(html|js|css)|options\.(html|js)|lib\/[a-z-]+\.js|inpage-panel\.js|content\.js|scripts\/fixtures\/maps\.js)$/;
    if (!allowed.test(path)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "application/javascript");
    response.end(await readFile(new URL(path.slice(1), root)));
  } catch (error) { response.writeHead(500).end(error.message); }
});

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Chrome did not expose its debugging endpoint.")), 20000);
    browser.on("error", error => { clearTimeout(timeout); reject(error); });
    browser.stderr.on("data", data => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task?.reject(new Error(message.error.message));
    else task?.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  await page("Page.enable");
  await page("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
    if (window !== window.top && window.parent.__mapsBridge) {
      window.chrome = window.parent.__mapsBridge.createChrome(window);
      return;
    }
    window.__events = {};
    const storageListeners = [];
    __events.storage = (...args) => storageListeners.forEach(listener => listener(...args));
    window.__pending = [];
    window.__firstRead = true;
    window.__place = { name: "Browser Fixture Cafe", address: "123 Main St, San Francisco, CA 94103", category: "Cafe", county: "sf", key: "fixture-1" };
    window.chrome = {
      runtime: { sendMessage: message => {
        if (message.type === "READ_SELECTED_PLACE") {
          const context = __firstRead ? null : __place;
          __firstRead = false;
          return Promise.resolve({ok:true, context});
        }
        return new Promise(resolve => __pending.push({ message, resolve }));
      } },
      windows: { getCurrent: async () => ({ id: 1 }) },
      tabs: {
        query: async () => [{ id: 5 }],
        sendMessage: async () => __place,
        onActivated: { addListener: callback => __events.activate = callback },
        onUpdated: { addListener: callback => __events.update = callback }
      },
      storage: {
        local: {
          get: async key => ({[key]:localStorage.getItem("fixture-"+key) ?? undefined}),
          set: async values => {
            if (window.__failDisplaySave) throw new Error("Fixture preference write failed");
            for (const [key,value] of Object.entries(values)) {
              localStorage.setItem("fixture-"+key,value);
              __events.storage({[key]:{newValue:value}},"local");
            }
          }
        },
        onChanged: { addListener: callback => storageListeners.push(callback) }
      },
      sidePanel: {
        open: async ({ tabId }) => { (window.__sidePanelOpens ??= []).push(tabId); }
      }
    };
    window.close = () => { window.__closed = true; };
    window.__select = (name, key) => {
      __place = { name, key, address: "123 Main St, San Francisco, CA 94103", category: "Cafe", county: "sf" };
      __events.storage({ "place:5": { newValue: __place } }, "session");
    };
    })();
  ` });
  await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/sidepanel.html` });
  const evaluate = async expression => {
    const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition not met: ${expression}`);
  }
  await waitFor("document.querySelector('#status')?.textContent.includes('unknown categories are skipped')");
  await evaluate(`HealthInspectDisplay.save("inline")`);
  await waitFor("localStorage.getItem('fixture-displayMode') === 'inline'");
  assert.equal(await evaluate("document.body.classList.contains('inline-view')"), false);
  assert.equal(await evaluate("document.querySelector('#record-details').open"), true);
  await evaluate(`HealthInspectDisplay.save("floating")`);
  await waitFor("localStorage.getItem('fixture-displayMode') === 'floating'");
  assert.equal(await evaluate("__pending.length"), 0);
  await evaluate("__events.update(5, {status:'complete'})");
  await waitFor("window.__pending?.length === 1");
  assert.equal(await evaluate("document.querySelector('#place-name').textContent"), "Browser Fixture Cafe");
  assert.equal(await evaluate("document.querySelector('#county').value"), "sf");
  assert.equal(await evaluate("Boolean(document.querySelector('#results').compareDocumentPosition(document.querySelector('#jurisdiction')) & Node.DOCUMENT_POSITION_FOLLOWING)"), true);
  assert.equal(await evaluate("document.querySelector('#county-override').open"), false);
  await evaluate(`__select("Second Fixture", "fixture-2")`);
  await waitFor("__pending.length === 2");
  await evaluate(`__pending[0].resolve({ok: true, data: {kind: "unavailable", message: "STALE RESPONSE"}})`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!(await evaluate("document.body.textContent")).includes("STALE RESPONSE"));
  await evaluate(`__pending[1].resolve({ok: false, error: "Test source unavailable"})`);
  await waitFor("document.querySelector('#status').textContent.includes('Test source unavailable')");
  assert.equal(await evaluate("document.querySelector('#retry').hidden"), false);
  await evaluate(`document.querySelector('#retry').click()`);
  await waitFor("__pending.length === 3");
  await evaluate(`__pending[2].resolve({ok:true,data:{
    kind:"records",facility:{id:"fixture",name:"<img src=x onerror=alert(1)>",address:"123 Main St",candidateKey:"current",exactMatch:true},
    candidates:[
      {id:"fixture",name:"Current fixture",address:"123 Main St",candidateKey:"current"},
      {id:"alternate",name:"Alternate fixture",address:"123 Main St Ste 2",candidateKey:"alternate"}
    ],
    source:{url:"https://example.org/official-fixture",dataset:"https://example.org/dataset-fixture",retrievedAt:"2026-01-01T00:00:00Z",updatedAt:"2025-12-31",warning:"Test fixture only",note:"Fixture history limit"},
    inspections:[{date:"2025-01-01",type:"Routine",score:90,violationsUrl:"https://example.org/violation-fixture",violations:[{description:"Fixture category",comment:"Qualified fixture observation",severity:"Critical"}]}]
  }})`);
  await waitFor("document.querySelectorAll('#results details').length === 2");
  assert.equal(await evaluate("document.querySelectorAll('#results img').length"), 0);
  assert.ok((await evaluate("document.querySelector('#results').textContent")).includes("<img src=x onerror=alert(1)>"));
  assert.ok((await evaluate("document.querySelector('#results').textContent")).includes("Qualified fixture observation"));
  assert.equal(await evaluate("document.querySelectorAll('#results a').length"), 4);
  assert.equal(await evaluate("document.querySelector('[data-candidate-key=current]').disabled"), true);
  await evaluate("document.querySelector('.match-choices').open = true; document.querySelector('[data-candidate-key=alternate]').click()");
  await waitFor("__pending.length === 4");
  assert.equal(await evaluate("__pending[3].message.type"), "LOAD_FACILITY");
  assert.equal(await evaluate("__pending[3].message.candidateKey"), "alternate");
  await evaluate("__pending[3].resolve({ok:false,error:'Fixture alternative unavailable'})");
  await waitFor("document.querySelector('#retry').hidden === false");
  await evaluate("document.querySelector('#retry').click()");
  await waitFor("__pending.length === 5");
  assert.equal(await evaluate("__pending[4].message.candidateKey"), "alternate");
  await evaluate(`__pending[4].resolve({ok:true,data:{
    kind:"records",confirmed:true,facility:{id:"alternate",name:"Alternate fixture",address:"123 Main St Ste 2",candidateKey:"alternate"},
    candidates:[{id:"alternate",name:"Alternate fixture",address:"123 Main St Ste 2",candidateKey:"alternate"}],
    source:{url:"https://example.org/fixture",retrievedAt:"2026-01-01T00:00:00Z"},inspections:[]
  }})`);
  await waitFor("document.querySelector('#results').textContent.includes('Match selected by you')");
  await evaluate("document.querySelector('[data-action=auto-match]').click()");
  await waitFor("__pending.length === 6");
  assert.equal(await evaluate("__pending[5].message.type"), "LOOKUP");
  await evaluate(`__pending[5].resolve({ok:true,data:{
    kind:"records",facility:{id:"fuzzy",name:"Fuzzy restored fixture",address:"123 Main St",candidateKey:"fuzzy",exactMatch:false,matchBasis:"similar"},
    candidates:[
      {id:"fuzzy",name:"Fuzzy restored fixture",address:"123 Main St",candidateKey:"fuzzy"},
      {id:"other",name:"Other fixture",address:"123 Main St",candidateKey:"other"}
    ],
    source:{url:"https://example.org/fixture",retrievedAt:"2026-01-01T00:00:00Z"},inspections:[]
  }})`);
  await waitFor("document.querySelector('#results').textContent.includes('Similar name and address')");
  assert.ok(!(await evaluate("document.querySelector('#results').textContent")).includes("Only matching record"));
  await evaluate(`__events.storage({"place:5":{newValue:null}}, "session")`);
  await waitFor("document.querySelector('#place').hidden");
  assert.equal(await evaluate("document.querySelector('#results').textContent"), "");
  await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/maps/place/Fixture/` });
  const panelDoc = "window.__panelRoot?.querySelector('iframe')?.contentDocument";
  await waitFor(`${panelDoc}?.querySelector('#results')?.textContent.includes('Official score: 95')`);
  assert.equal(await evaluate("__lookups.length"), 1);
  assert.equal(await evaluate("__lookups[0].county"), "sf");
  assert.ok((await evaluate(`${panelDoc}.querySelector('#results').textContent`)).includes("Only matching record"));
  assert.equal(await evaluate(`${panelDoc}.querySelector('[data-candidate-key=sole]').disabled`), true);
  assert.equal(await evaluate("__frameReads[0]"), 97854);
  await evaluate("__updateListeners.forEach(listener => listener(37, {status:'loading'}))");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluate("__lookups.length"), 1);
  assert.ok((await evaluate(`${panelDoc}.querySelector('#results').textContent`)).includes("Official score: 95"));
  const foodLookupCount = await evaluate("__lookups.length");
  for (const id of ["hotel", "supply", "no-category"]) {
    await evaluate(`document.querySelector('#select-${id}').click()`);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await evaluate("__lookups.length"), foodLookupCount);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "none");
  }
  await evaluate("document.querySelector('#select-sf').click()");
  await waitFor(`${panelDoc}?.querySelector('#results')?.textContent.includes('Official score: 95')`);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "block");
  assert.equal(await evaluate(`${panelDoc}.querySelector('#county-override').open`), false);
  await evaluate("__panelRoot.querySelector('button').click()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "none");
  await evaluate("document.querySelector('#select-sc').click()");
  await waitFor(`${panelDoc}?.querySelector('#results')?.textContent.includes('Fixture Cafe SC')`);
  assert.equal(await evaluate("__lookups.at(-1).county"), "sc");
  const scText = await evaluate(`${panelDoc}.querySelector('#results').textContent`);
  assert.ok(scText.includes("Official score: 95"));
  assert.ok(scText.includes("Most recent routine inspection · 2025-01-01"));
  assert.ok(scText.includes("2025-02-01 · REINSPECTION"));
  assert.ok(!scText.includes("Official numerical score: not provided"));
  assert.equal(await evaluate(`${panelDoc}.querySelector('#county').value`), "sc");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "block");
  await evaluate("__activationListeners.forEach(listener => listener({windowId:1, tabId:99}))");
  assert.equal(await evaluate(`${panelDoc}.querySelector('#place-name').textContent`), "Fixture Cafe SC");
  await evaluate(`(() => {
    const select = ${panelDoc}.querySelector('#county');
    select.value = "sf";
    select.dispatchEvent(new Event("change"));
  })()`);
  await waitFor("__lookups.at(-1).county === 'sf'");
  await evaluate("document.querySelector('#select-sm').click()");
  await waitFor(`${panelDoc}?.querySelector('#results')?.textContent.includes('Synthetic cooling citation')`);
  assert.equal(await evaluate("__lookups.at(-1).county"), "sm");
  const smText = await evaluate(`${panelDoc}.querySelector('#results').textContent`);
  assert.ok(smText.includes("Official result: Pass"));
  assert.ok(smText.includes("Official numerical score: not provided"));
  assert.ok(smText.includes("Retrieved violation entries: 1"));
  assert.ok(smText.includes("County-reported open violations: 0 (not total cited violations)"));
  assert.ok(smText.includes("County-recorded complied-on date: 2026-01-26"));
  assert.ok(smText.includes("Synthetic sink reading: 100 DEGREES F."));
  assert.ok(smText.includes("County inspection history - visit FIXTURE"));
  assert.ok(!smText.includes("Official score: 95"));
  const beforeModeChange = await evaluate("__lookups.length");
  await evaluate(`(() => { window.__retainedFrame = __panelRoot.querySelector('iframe').contentWindow;
    ${panelDoc}.defaultView.HealthInspectDisplay.save("inline"); })()`);
  await waitFor(`document.querySelector('#health-inspect-panel')?.dataset.layout === 'inline' && ${panelDoc}?.body.classList.contains('inline-view')`);
  assert.equal(await evaluate("document.querySelector('[data-item-id=address]').closest('[role=region]').previousElementSibling.id"), "health-inspect-panel");
  assert.equal(await evaluate(`${panelDoc}.querySelector('#record-details').open`), false);
  assert.ok((await evaluate(`${panelDoc}.querySelector('#inline-result').textContent`)).includes("Latest inspection: 2026-01-26 · Pass"));
  await waitFor("parseFloat(__panelRoot.querySelector('iframe').style.height) < 650");
  assert.equal(await evaluate("__panelRoot.querySelector('iframe').contentWindow === __retainedFrame"), true);
  assert.equal(await evaluate("__lookups.length"), beforeModeChange);
  const collapsedHeight = await evaluate("parseFloat(__panelRoot.querySelector('iframe').style.height)");
  await evaluate(`(() => { const details = ${panelDoc}.querySelector('#record-details'); details.open = true; })()`);
  await waitFor(`parseFloat(__panelRoot.querySelector('iframe').style.height) > ${collapsedHeight + 50}`);
  await evaluate(`(() => { const details = ${panelDoc}.querySelector('#record-details'); details.open = false; })()`);
  await waitFor(`parseFloat(__panelRoot.querySelector('iframe').style.height) <= ${collapsedHeight + 5}`);

  await evaluate("document.querySelector('[data-item-id=address]').closest('[role=region]').removeAttribute('role')");
  await waitFor("document.querySelector('#health-inspect-panel').dataset.layout === 'floating'");
  assert.ok((await evaluate("__panelRoot.querySelector('.mode-notice').textContent")).includes("unavailable"));
  assert.equal(await evaluate("localStorage.getItem('fixture-displayMode')"), "inline");
  await evaluate("document.querySelector('[aria-label=\"Information for fixture\"]').setAttribute('role','region')");
  await waitFor("document.querySelector('#health-inspect-panel').dataset.layout === 'inline'");
  assert.equal(await evaluate("__lookups.length"), beforeModeChange);

  await evaluate(`(() => { const old = document.querySelector('main'); const replacement = old.cloneNode(true);
    replacement.querySelector('#health-inspect-panel').remove(); old.replaceWith(replacement); })()`);
  await waitFor(`${panelDoc}?.querySelector('#inline-result')?.textContent.includes('Pass')`);
  assert.equal(await evaluate("document.querySelectorAll('#health-inspect-panel').length"), 1);
  assert.equal(await evaluate("document.querySelector('[data-item-id=address]').closest('[role=region]').previousElementSibling.id"), "health-inspect-panel");
  await evaluate("document.querySelector('#select-sc').click()");
  await waitFor(`${panelDoc}?.querySelector('#inline-result')?.textContent.includes('Official routine score: 95')`);
  const compactSc = await evaluate(`${panelDoc}.querySelector('#inline-result').textContent`);
  assert.ok(compactSc.includes("2025-01-01"));
  assert.ok(compactSc.includes("Latest inspection: 2025-02-01"));
  assert.ok(!compactSc.includes("Fixture Cafe SM"));
  await evaluate(`${panelDoc}.defaultView.HealthInspectDisplay.save("floating")`);
  await waitFor("document.querySelector('#health-inspect-panel').dataset.layout === 'floating'");
  assert.equal(await evaluate(`${panelDoc}.querySelector('#record-details').open`), true);
  assert.ok((await evaluate(`${panelDoc}.querySelector('#county-detection').textContent`)).includes("detected automatically"));
  const lookupCount = await evaluate("__lookups.length");
  await evaluate("document.querySelector('#select-unknown').click()");
  await waitFor("getComputedStyle(document.querySelector('#health-inspect-panel')).display === 'none'");
  assert.equal(await evaluate("__lookups.length"), lookupCount);
  await evaluate("document.querySelector('#clear-place').click()");
  await waitFor("getComputedStyle(document.querySelector('#health-inspect-panel')).display === 'none'");
  assert.equal(await evaluate("__panelRoot.querySelector('iframe').src"), "about:blank");
  await evaluate(`chrome.runtime.sendMessage = async () => { throw new Error("Extension context invalidated."); };
    chrome.runtime.getURL = () => { throw new Error("Extension context invalidated."); };
    document.querySelector('#select-sf').click();`);
  await waitFor("__panelRoot.querySelector('.error').textContent.includes('Extension context invalidated')");
  assert.equal(await evaluate("__panelRoot.querySelector('iframe').hidden"), true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "block");
  await evaluate("__panelRoot.querySelector('[data-action=reload]').click()");
  await waitFor(`${panelDoc}?.querySelector('#results')?.textContent.includes('Official score: 95')`);
  await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/maps/place/Fixture/?simulate-invalidated=1` });
  await waitFor("window.__panelRoot?.querySelector('.error')?.textContent.includes('Extension context invalidated')");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "block");
  assert.equal(await evaluate("__panelRoot.querySelector('iframe').hidden"), true);
  assert.equal(await evaluate("__lookups.length"), 0);
  await evaluate("localStorage.setItem('fixture-displayMode','inline')");
  await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/maps/place/Fixture/` });
  await waitFor(`${panelDoc}?.querySelector('#inline-result')?.textContent.includes('Official score: 95')`);
  assert.equal(await evaluate("document.querySelector('#health-inspect-panel').dataset.layout"), "inline");
  assert.equal(await evaluate(`${panelDoc}.querySelector('#record-details').open`), false);
  await evaluate("document.querySelector('#select-hotel').click()");
  await waitFor("getComputedStyle(document.querySelector('#health-inspect-panel')).display === 'none'");
  assert.equal(await evaluate("__lookups.length"), 1);
  await evaluate("document.querySelector('#select-unknown').click()");
  await new Promise(resolve => setTimeout(resolve, 100));
  // Addresses outside the three supported counties never open the panel at all.
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#health-inspect-panel')).display"), "none");
  assert.equal(await evaluate("__lookups.length"), 1);
  await evaluate(`window.__nextLookupResponse = {ok:false,error:"Inline fixture source error"}; document.querySelector('#select-sf').click()`);
  await waitFor(`${panelDoc}?.querySelector('#inline-result')?.textContent.includes('Inline fixture source error')`);
  assert.equal(await evaluate(`${panelDoc}.querySelector('#record-details').open`), true);
  assert.equal(await evaluate(`${panelDoc}.querySelector('#retry').hidden`), false);
  await evaluate(`window.__nextLookupResponse = {ok:true,data:{
    kind:"candidates",message:"Choose the fixture license",
    candidates:[{id:"one",name:"First fixture license",address:"456 First St",candidateKey:"one"},
      {id:"two",name:"Second fixture license",address:"456 First St",candidateKey:"two"}]
  }}; document.querySelector('#select-sc').click()`);
  await waitFor(`${panelDoc}?.querySelector('[data-candidate-key=two]') != null`);
  for (const value of ["floating", "inline"]) {
    await evaluate(`${panelDoc}.defaultView.HealthInspectDisplay.save("${value}")`);
    await waitFor(`document.querySelector('#health-inspect-panel').dataset.layout === '${value}'`);
    assert.equal(await evaluate(`${panelDoc}.querySelector('#record-details').open`), true);
  }
  await evaluate("document.documentElement.moveBefore = undefined; document.querySelector('main').moveBefore = undefined");
  for (const value of ["floating", "inline"]) {
    await evaluate(`${panelDoc}.defaultView.HealthInspectDisplay.save("${value}")`);
    await waitFor(`document.querySelector('#health-inspect-panel').dataset.layout === '${value}' && ${panelDoc}?.querySelector('#results')?.textContent.includes('Official score: 95')`);
    assert.equal(await evaluate("document.querySelectorAll('#health-inspect-panel').length"), 1);
  }
  console.log("Browser checks passed: switchable persistent inline/floating layouts, compact sizing, Maps rerenders/fallback, matching and errors, non-food suppression, safe rendering, and reload recovery.");

  // --- Toolbar-icon settings popup (options.html) ---
  await evaluate(`${panelDoc}.defaultView.HealthInspectDisplay.save("inline")`);
  await waitFor("localStorage.getItem('fixture-displayMode') === 'inline'");
  await page("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/options.html` });
  // The popup's initial read is async, so wait for the switch to reflect the
  // stored "inline" value (rather than its unchecked default) before interacting,
  // avoiding a race with options.js still starting up.
  await waitFor("document.querySelector('#display-mode')?.checked === true");
  await evaluate(`document.querySelector('#display-mode').checked = false; document.querySelector('#display-mode').dispatchEvent(new Event("change"))`);
  await waitFor("localStorage.getItem('fixture-displayMode') === 'floating'");
  assert.equal(await evaluate("document.querySelector('#display-mode').checked"), false);
  await evaluate(`window.__failDisplaySave = true; document.querySelector('#display-mode').checked = true; document.querySelector('#display-mode').dispatchEvent(new Event("change"))`);
  await waitFor("document.querySelector('#display-error').textContent.includes('Fixture preference write failed')");
  assert.equal(await evaluate("document.querySelector('#display-mode').checked"), false);
  assert.equal(await evaluate("localStorage.getItem('fixture-displayMode')"), "floating");
  await evaluate("window.__failDisplaySave = false");
  await evaluate("document.querySelector('#open-side-panel').click()");
  await waitFor("window.__sidePanelOpens?.length === 1");
  assert.equal(await evaluate("window.__sidePanelOpens[0]"), 5);
  assert.equal(await evaluate("window.__closed"), true);
  console.log("Options popup checks passed: display switch persists and the manual side-panel launcher opens the panel.");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await new Promise(resolve => browser.once("exit", resolve));
  }
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
