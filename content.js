(() => {
  let sentKey;
  let timer;
  let generation = 0;
  let stopped = false;
  let publication = Promise.resolve();
  let publicationVersion = 0;
  let pendingKey;
  let previousSelection;
  let lastPlace;
  let lastPlaceSelection;
  let blockedKey;
  let pageHidden = false;

  function onPageHide() {
    pageHidden = true;
    generation++;
    clearTimeout(timer);
    pendingKey = undefined;
    void send(null);
  }

  function onPageShow() {
    pageHidden = false;
    schedule();
  }

  function stopWatching() {
    stopped = true;
    generation++;
    clearTimeout(timer);
    clearInterval(navigationWatch);
    observer.disconnect();
    globalThis.removeEventListener("pagehide", onPageHide);
    globalThis.removeEventListener("pageshow", onPageShow);
  }

  function snapshot() {
    const addressNode = document.querySelector('button[data-item-id="address"]');
    const nameNode = document.querySelector("h1.DUwDvf") || document.querySelector('[role="main"] h1');
    const categoryNode = document.querySelector('button[jsaction*="pane.rating.category"], button.DkEaL');
    const selection = location.href.match(/!1s([^!/?]+)/)?.[1]
      || location.href.match(/\/maps\/place\/([^/?]+)/)?.[1] || null;
    if (previousSelection !== undefined && selection !== previousSelection) {
      blockedKey = selection && selection !== lastPlaceSelection ? lastPlace?.key : undefined;
    }
    previousSelection = selection;
    const context = globalThis.HealthInspectMaps.contextFromSnapshot({
      url: location.href,
      name: nameNode?.textContent,
      address: addressNode?.getAttribute("aria-label") || addressNode?.textContent,
      category: categoryNode?.textContent,
    });
    // Same-name branches can keep the old address visible while Maps navigates.
    if (context?.key && context.key === blockedKey) return null;
    if (context) blockedKey = undefined;
    return context;
  }

  function send(context) {
    const key = context?.key || null;
    if (key === sentKey || stopped) return publication;
    sentKey = key;
    if (!context) globalThis.HealthInspectPanel.update(null);
    if (context) {
      lastPlace = context;
      lastPlaceSelection = previousSelection;
    }
    const version = ++publicationVersion;
    // Serialize storage updates so an older acknowledgement cannot restore an old place.
    publication = publication.then(async () => {
      if (stopped || (pageHidden && context)) return;
      let operation = "sync the selected restaurant";
      try {
        if (!chrome.runtime?.id) throw new Error("Extension context invalidated.");
        const response = await chrome.runtime.sendMessage({ type: "MAP_CONTEXT", context });
        if (!response?.ok) throw new Error(response?.error || "No acknowledgement from the extension.");
        operation = "display the inspection panel";
        if (context && version === publicationVersion) globalThis.HealthInspectPanel.update(context);
      } catch (error) {
        const detail = error?.message || String(error);
        const invalidated = !chrome.runtime?.id || /extension context invalidated/i.test(detail);
        if (!invalidated && version !== publicationVersion) {
          console.warn(`[Health Inspect] An earlier selection could not ${operation}: ${detail}`, error);
          return;
        }
        stopWatching();
        const message = invalidated
          ? `Health Inspect was reloaded, updated, or disabled. Reload this Maps tab to reconnect. Details: ${detail}`
          : `Health Inspect could not ${operation}. Reload this Maps tab to retry. Details: ${detail}`;
        if (invalidated) console.info(`[Health Inspect] ${message}`);
        else console.warn(`[Health Inspect] ${message}`, error);
        globalThis.HealthInspectPanel.error(message);
      }
    });
    return publication;
  }

  function schedule() {
    if (stopped || pageHidden) return;
    const current = snapshot();
    const key = current?.key || null;
    if (key && key === sentKey) globalThis.HealthInspectPanel.refresh?.();
    if (key === pendingKey) return;
    clearTimeout(timer);
    pendingKey = undefined;
    if (key === sentKey) return;
    pendingKey = key;
    const version = ++generation;
    // Clear stale results before waiting for the new details to settle.
    void send(null);
    timer = setTimeout(() => {
      pendingKey = undefined;
      const next = snapshot();
      if (version === generation && current?.key === next?.key) void send(next);
      else schedule();
    }, 350);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
  // Recheck delayed details even when no URL or observed DOM mutation changes.
  const navigationWatch = setInterval(schedule, 500);
  globalThis.addEventListener("pagehide", onPageHide);
  globalThis.addEventListener("pageshow", onPageShow);
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "READ_MAP_CONTEXT") respond(stopped || pageHidden ? null : snapshot());
  });
  schedule();
})();
