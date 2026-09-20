import "./lib/display-preferences.js";

const $ = id => document.getElementById(id);
let displayMode = "floating";

globalThis.HealthInspectDisplay.observe(value => {
  displayMode = value;
  $("display-mode").checked = value === "inline";
  $("display-error").hidden = true;
}, error => {
  $("display-error").textContent = `Could not read display preference: ${error.message}`;
  $("display-error").hidden = false;
});

$("display-mode").addEventListener("change", async () => {
  const control = $("display-mode");
  const value = control.checked ? "inline" : "floating";
  control.disabled = true;
  try {
    await globalThis.HealthInspectDisplay.save(value);
  } catch (error) {
    control.checked = displayMode === "inline";
    $("display-error").textContent = `Could not save display preference: ${error.message}`;
    $("display-error").hidden = false;
  } finally {
    control.disabled = false;
  }
});

// Resolved once, at popup open, so the click handler below can call
// chrome.sidePanel.open() as its first statement (no preceding await),
// which Chrome requires to treat the call as a direct user gesture.
const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
$("open-side-panel").addEventListener("click", () => {
  const button = $("open-side-panel");
  if (!activeTab) {
    $("side-panel-error").textContent = "No active browser tab was found.";
    $("side-panel-error").hidden = false;
    return;
  }
  button.disabled = true;
  chrome.sidePanel.open({ tabId: activeTab.id })
    .then(() => window.close())
    .catch(error => {
      $("side-panel-error").textContent = `Could not open the side panel: ${error.message}`;
      $("side-panel-error").hidden = false;
    })
    .finally(() => { button.disabled = false; });
});
