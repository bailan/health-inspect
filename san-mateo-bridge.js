(() => {
  if (location.origin !== "https://smcehs.my.site.com") throw new Error("The San Mateo bridge requires the official county page.");

  async function read(request) {
    const validated = globalThis.HealthInspectSanMateoRequest.validate(request);
    const response = await fetch(validated.url, {
      method: validated.method, body: validated.body, credentials: "omit",
      headers: validated.method === "POST"
        ? { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }
        : { Accept: "text/html" },
      signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.text() };
  }

  function listener(message, sender, respond) {
    if (message?.type !== "SM_PUBLIC_FETCH") return;
    if (sender.id !== chrome.runtime.id || sender.tab) {
      respond({ ok: false, error: "Only this extension's background may request public county records." });
      return;
    }
    read(message.request).then(result => respond({ ok: true, ...result }))
      .catch(error => respond({ ok: false, error: error.message }));
    return true;
  }

  // Re-injection refreshes this listener without reloading or changing the county page.
  if (globalThis.healthInspectSanMateoListener) {
    chrome.runtime.onMessage.removeListener(globalThis.healthInspectSanMateoListener);
  }
  globalThis.healthInspectSanMateoListener = listener;
  chrome.runtime.onMessage.addListener(listener);
})();
