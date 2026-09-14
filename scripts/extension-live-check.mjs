import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const profile = await mkdtemp(join(tmpdir(), "health-inspect-extension-check-"));
const root = fileURLToPath(new URL("../", import.meta.url));
let browser;
const pending = new Map();
const requests = new Map();
const extraHeaders = new Map();
let sequence = 0;
try {
  browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  browser.on("error", error => {
    for (const task of pending.values()) task.reject(error);
  });
  let buffer = "";
  browser.stdio[4].on("data", data => {
    buffer += data.toString();
    let boundary;
    while ((boundary = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      if (message.id) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) task?.reject(new Error(message.error.message));
        else task?.resolve(message.result);
      } else if (message.method === "Network.requestWillBeSent") {
        const request = message.params.request;
        if (request.url.startsWith("https://smcehs.my.site.com/")) {
          const extra = extraHeaders.get(message.params.requestId);
          requests.set(message.params.requestId, { method: request.method, path: new URL(request.url).pathname,
            bridge: Boolean(message.params.initiator?.stack?.callFrames.some(frame => frame.url === `chrome-extension://${id}/san-mateo-bridge.js`)),
            origin: request.headers.Origin || request.headers.origin || "(absent)", cookie: false, extraSeen: false, ...extra });
        }
      } else if (message.method === "Network.requestWillBeSentExtraInfo") {
        const extra = {
          origin: message.params.headers.Origin || message.params.headers.origin || "(absent)",
          cookie: Object.keys(message.params.headers).some(key => key.toLowerCase() === "cookie"), extraSeen: true,
        };
        extraHeaders.set(message.params.requestId, extra);
        const request = requests.get(message.params.requestId);
        if (request) Object.assign(request, extra);
      } else if (message.method === "Network.responseReceived") {
        const request = requests.get(message.params.requestId);
        if (request) request.status = message.params.response.status;
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 60000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const { id } = await send("Extensions.loadUnpacked", { path: root });
  let worker;
  for (let attempt = 0; attempt < 20 && !worker; attempt++) {
    const { targetInfos } = await send("Target.getTargets");
    worker = targetInfos.find(target => target.type === "service_worker" && target.url === `chrome-extension://${id}/background.js`);
    if (!worker) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(worker, "The installed extension must start its real service worker.");
  const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  await send("Network.enable", {}, sessionId);
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${id}/sidepanel.html` });
  const { sessionId: pageSession } = await send("Target.attachToTarget", { targetId, flatten: true });
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt++) {
    const probe = await send("Runtime.evaluate", {
      expression: "Boolean(globalThis.chrome?.runtime?.id)", returnByValue: true,
    }, pageSession);
    ready = probe.result.value === true;
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "The extension panel must finish navigating before messaging its worker.");
  const expression = `(async () => {
      const response = await chrome.runtime.sendMessage({type:"LOOKUP",county:"sm",
        place:{name:"Town",address:"716 Laurel Street, San Carlos, CA 94070",category:"Restaurant",key:"town-live-check"}});
      if (!response?.ok) throw new Error(response?.error || "No background response");
      const result = response.data;
      return {kind:result.kind,facility:result.facility?.name,
        inspections:result.inspections?.map(i=>({date:i.date,result:i.result,violations:i.violations.length,readings:i.fieldReadings.length}))};
    })()`;
  const evaluate = async source => {
    const response = await send("Runtime.evaluate", {
      expression: source, awaitPromise: true, returnByValue: true,
    }, pageSession);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const activeBefore = await evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0].id)");
  const first = await evaluate(expression);
  assert.equal(first.kind, "records");
  assert.ok(first.inspections.length > 0);
  assert.equal(requests.size, 0, "County network requests must not originate in the extension worker.");
  const countyTabs = (await send("Target.getTargets")).targetInfos.filter(target =>
    target.type === "page" && target.url.startsWith("https://smcehs.my.site.com/s/inspection-report-search"));
  assert.equal(countyTabs.length, 1, "The extension should open just one county portal tab.");
  const { sessionId: countySession } = await send("Target.attachToTarget", { targetId: countyTabs[0].targetId, flatten: true });
  await send("Network.enable", {}, countySession);
  const second = await evaluate(expression);
  assert.equal(second.kind, "records");
  assert.equal(await evaluate("chrome.tabs.query({active:true,currentWindow:true}).then(tabs=>tabs[0].id)"), activeBefore);
  const bridgePosts = () => [...requests.values()].filter(request => request.bridge
    && request.method === "POST" && request.path === "/s/sfsites/aura");
  // The portal also makes its own requests; inspect only our bridge and let CDP flush its events.
  for (let attempt = 0; attempt < 40; attempt++) {
    const observed = bridgePosts();
    if (observed.length >= 3 && observed.every(request => request.extraSeen && request.status !== undefined)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const posts = bridgePosts();
  assert.ok(posts.length >= 3, "Expected live facility, history, and detail read requests.");
  assert.ok(posts.every(request => request.extraSeen && request.origin === "https://smcehs.my.site.com" && request.status === 200 && !request.cookie),
    `The bridge must make successful, cookie-free same-origin requests: ${JSON.stringify(posts)}`);
  const tabsAfter = await evaluate("chrome.tabs.query({url:'https://smcehs.my.site.com/s/inspection-report-search*'}).then(tabs=>tabs.length)");
  assert.equal(tabsAfter, 1, "Repeated lookups must reuse the portal, not accumulate tabs.");
  console.log(`Real Chrome extension: ${second.facility}, ${second.inspections.length} inspections; county-tab reuse, active-tab preservation, and cookie-free same-origin reads passed.`);
} finally {
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    await new Promise(resolve => browser.once("exit", resolve));
  }
  for (const task of pending.values()) task.reject(new Error("Browser check ended."));
  await rm(profile, { recursive: true, force: true });
}
