import { COUNTIES } from "./counties.js";
import { SourceAccessError } from "./http.js";
import "./san-mateo-request.js";

export function createSanMateoTransport(api) {
  let connecting;

  function waitForPage(tab) {
    if (tab.status === "complete") return Promise.resolve(tab);
    return new Promise((resolve, reject) => {
      const finish = (error, ready) => {
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(updated);
        api.tabs.onRemoved.removeListener(removed);
        if (error) reject(error); else resolve(ready);
      };
      const updated = (id, change, ready) => {
        if (id === tab.id && change.status === "complete") finish(null, ready);
      };
      const removed = id => {
        if (id === tab.id) finish(new Error("The San Mateo portal tab was closed. Retry to reopen it."));
      };
      const timer = setTimeout(() => finish(new Error("The San Mateo portal tab did not finish loading. Retry or use the county website.")), 20000);
      api.tabs.onUpdated.addListener(updated);
      api.tabs.onRemoved.addListener(removed);
      api.tabs.get(tab.id).then(current => {
        if (current.status === "complete") finish(null, current);
      }).catch(error => finish(error));
    });
  }

  async function portal() {
    if (connecting) return connecting;
    connecting = (async () => {
      const tabs = await api.tabs.query({ url: "https://smcehs.my.site.com/s/inspection-report-search*" });
      const tab = tabs[0] || await api.tabs.create({ url: COUNTIES.sm.url, active: false });
      const ready = await waitForPage(tab);
      if (new URL(ready.url).origin !== "https://smcehs.my.site.com") throw new Error("The county tab navigated away from San Mateo's public portal.");
      const injected = await api.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["lib/san-mateo-request.js", "san-mateo-bridge.js"],
      });
      const documentId = injected.find(result => result.frameId === 0)?.documentId;
      if (!documentId) throw new Error("Could not connect to the San Mateo portal document.");
      return { tabId: tab.id, documentId };
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return async (url, options = {}) => {
    const request = globalThis.HealthInspectSanMateoRequest.validate({
      url: String(url), method: options.method || "GET",
      ...(options.body == null ? {} : { body: String(options.body) }),
    });
    const { signal } = options;
    signal?.throwIfAborted();
    let abort;
    const work = (async () => {
      const target = await portal();
      signal?.throwIfAborted();
      const response = await api.tabs.sendMessage(target.tabId, { type: "SM_PUBLIC_FETCH", request }, { documentId: target.documentId });
      if (!response?.ok) throw new Error(response?.error || "The San Mateo portal did not respond. Keep its tab open and retry.");
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || typeof response.body !== "string") {
        throw new Error("The San Mateo portal returned an invalid response.");
      }
      return new Response(response.body || null, { status: response.status });
    })();
    try {
      if (!signal) return await work;
      return await Promise.race([work, new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError") throw error;
      throw new SourceAccessError(`San Mateo portal access failed: ${error.message} Keep the county tab open and retry.`, { cause: error });
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
}
