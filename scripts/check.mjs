import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const referenced = [
  manifest.background.service_worker, manifest.side_panel.default_path,
  ...manifest.content_scripts.flatMap(script => script.js),
  ...manifest.web_accessible_resources.flatMap(resource => resource.resources),
  "sidepanel.js", "sidepanel.css",
];
for (const file of referenced) await access(new URL(file, root));
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await check(path);
    else if (/\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path.pathname], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
await check(root);
console.log("Manifest references and JavaScript syntax are valid.");
