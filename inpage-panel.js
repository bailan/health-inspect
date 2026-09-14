(() => {
  let host;
  let frame;
  let errorNotice;
  let recovery;
  let currentKey;
  let dismissedKey;
  let currentPlace;
  let mode = "floating";
  let initialized = false;
  let effectiveMode;
  let modeNotice;
  let preferenceError = "";
  let failed = false;
  let inlineHeight = 360;
  let frameOrigin;

  function relocate(parent, before = null) {
    if (host.parentNode === parent && host.nextSibling === before) return;
    // Newer Chrome preserves iframe state on a move; older versions reload it safely.
    if (host.isConnected && parent.moveBefore) parent.moveBefore(host, before);
    else parent.insertBefore(host, before);
  }

  function position(forceFloating = false) {
    const address = document.querySelector('button[data-item-id="address"]');
    const anchor = address?.closest('[role="region"]');
    const inline = !forceFloating && mode === "inline" && anchor?.parentElement;
    relocate(inline ? anchor.parentElement : document.documentElement, inline ? anchor : null);
    const next = inline ? "inline" : "floating";
    if (next !== effectiveMode) {
      effectiveMode = next;
      host.dataset.layout = next;
      host.style.cssText = inline
        ? "all:initial!important;display:block!important;position:relative!important;margin:12px 16px!important;min-width:0!important;"
        : "all:initial!important;position:fixed!important;top:76px!important;right:16px!important;width:min(390px,calc(100vw - 32px))!important;height:min(760px,calc(100vh - 100px))!important;z-index:2147483646!important;";
      frame.style.height = inline ? `${inlineHeight}px` : "";
    }
    const notice = preferenceError
      ? `Display preference unavailable: ${preferenceError} Using the floating panel until a valid choice is saved.`
      : mode === "inline" && !inline && !forceFloating
        ? "Maps' information section is unavailable. Showing the floating panel until it returns." : "";
    if (modeNotice.textContent !== notice) modeNotice.textContent = notice;
    modeNotice.hidden = !notice;
  }

  function create() {
    host = document.createElement("div");
    host.id = "health-inspect-panel";
    effectiveMode = undefined;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: light; }
      section { height:100%; display:flex; flex-direction:column; background:#f4f7f6;
        border:1px solid #a9bbb4; border-radius:14px; overflow:hidden;
        box-shadow:0 8px 32px #0003; font:14px system-ui,sans-serif; color:#192c30; }
      .toolbar { display:flex; align-items:center; justify-content:space-between;
        padding:8px 12px; background:#173f3b; color:white; }
      button { font:inherit; border:1px solid #b7d9cd; border-radius:5px;
        padding:5px 10px; background:transparent; color:white; cursor:pointer; }
      button:focus-visible { outline:3px solid #f9c46a; outline-offset:2px; }
      iframe { flex:1; width:100%; min-height:0; border:0; background:#f4f7f6; }
      :host([data-layout="inline"]) section { height:auto; box-shadow:none; }
      :host([data-layout="inline"]) iframe { flex:none; }
      .mode-notice { padding:10px; background:#fff5da; color:#192c30; }
      .error { padding:12px; background:#fff0ed; color:#7c2720; }
      .recovery { padding:12px; background:#173f3b; }
      [hidden] { display:none; }
    `;
    const section = document.createElement("section");
    section.setAttribute("aria-label", "Health Inspect restaurant records");
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const label = document.createElement("strong");
    label.textContent = "Health Inspect · extension";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close health records for this restaurant");
    close.addEventListener("click", () => {
      dismissedKey = currentKey;
      host.style.setProperty("display", "none", "important");
      // Release the embedded page and its listeners while the user has dismissed it.
      frame.src = "about:blank";
    });
    toolbar.append(label, close);
    errorNotice = document.createElement("div");
    errorNotice.className = "error";
    errorNotice.setAttribute("role", "alert");
    errorNotice.hidden = true;
    modeNotice = document.createElement("div");
    modeNotice.className = "mode-notice";
    modeNotice.setAttribute("role", "status");
    modeNotice.hidden = true;
    recovery = document.createElement("div");
    recovery.className = "recovery";
    recovery.hidden = true;
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload Maps";
    reload.setAttribute("data-action", "reload");
    reload.addEventListener("click", () => location.reload());
    recovery.append(reload);
    frame = document.createElement("iframe");
    frame.title = "Official restaurant inspection records";
    section.append(toolbar, modeNotice, errorNotice, recovery, frame);
    root.append(style, section);
    document.documentElement.append(host);
  }

  function update(place) {
    currentPlace = place;
    currentKey = place?.key || null;
    if (!place) {
      dismissedKey = null;
      if (host) {
        host.style.setProperty("display", "none", "important");
        frame.src = "about:blank";
      }
      return;
    }
    if (!initialized || failed || currentKey === dismissedKey) return;
    if (!host) create();
    position();
    errorNotice.hidden = true;
    recovery.hidden = true;
    frame.hidden = false;
    const url = chrome.runtime.getURL("sidepanel.html?embedded=1");
    frameOrigin = url.split("/").slice(0, 3).join("/");
    if (frame.src !== url) frame.src = url;
    host.style.setProperty("display", "block", "important");
    if (effectiveMode === "floating") host.style.setProperty("height", "min(760px,calc(100vh - 100px))", "important");
  }

  function refresh() {
    if (!initialized || failed || !currentPlace || currentKey === dismissedKey) return;
    try {
      update(currentPlace);
    } catch (cause) {
      console.warn("[Health Inspect] Could not refresh the display.", cause);
      error(`Could not refresh the health-inspection display. Reload Maps to retry. Details: ${cause.message}`);
    }
  }

  function error(message) {
    // Recovery must work even before first render and after extension APIs expire.
    failed = true;
    if (!host) create();
    position(true);
    errorNotice.textContent = message;
    errorNotice.hidden = false;
    recovery.hidden = false;
    frame.hidden = true;
    frame.src = "about:blank";
    host.style.setProperty("display", "block", "important");
    host.style.setProperty("height", "auto", "important");
  }

  globalThis.addEventListener("message", event => {
    if (!frame || event.source !== frame.contentWindow || !currentPlace || failed) return;
    if (event.origin !== frameOrigin) return;
    const data = event.data;
    if (data?.type !== "HEALTH_INSPECT_SIZE" || data.key !== currentKey || !Number.isFinite(data.height)) return;
    inlineHeight = Math.max(120, Math.min(1600, Math.ceil(data.height)));
    if (effectiveMode === "inline" && frame.style.height !== `${inlineHeight}px`) frame.style.height = `${inlineHeight}px`;
  });
  globalThis.HealthInspectDisplay.observe(value => {
    if (mode !== value) dismissedKey = null;
    mode = value;
    initialized = true;
    preferenceError = "";
    refresh();
  }, cause => {
    mode = "floating";
    initialized = true;
    preferenceError = cause.message;
    console.warn("[Health Inspect] Could not read display preference.", cause);
    refresh();
  });
  globalThis.HealthInspectPanel = { update, refresh, error };
})();
