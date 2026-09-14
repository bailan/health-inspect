(() => {
  const key = "displayMode";
  function parse(value) {
    if (value === undefined) return "floating";
    if (value !== "floating" && value !== "inline") throw new Error("The saved display mode is invalid. Choose a display mode again.");
    return value;
  }
  function observe(onValue, onError) {
    let revision = 0;
    const listener = (changes, area) => {
      if (area !== "local" || !Object.hasOwn(changes, key)) return;
      revision++;
      try { onValue(parse(changes[key].newValue)); } catch (error) { onError(error); }
    };
    try {
      chrome.storage.onChanged.addListener(listener);
      const initial = revision;
      chrome.storage.local.get(key).then(values => {
        if (revision === initial) onValue(parse(values[key]));
      }).catch(error => { if (revision === initial) onError(error); });
    } catch (error) {
      onError(error);
    }
    return () => chrome.storage.onChanged.removeListener(listener);
  }
  async function save(value) {
    if (value === undefined) throw new Error("Choose a display mode.");
    await chrome.storage.local.set({ [key]: parse(value) });
  }
  globalThis.HealthInspectDisplay = Object.freeze({ parse, observe, save });
})();
