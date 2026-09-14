import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../lib/display-preferences.js", import.meta.url), "utf8");
function harness() {
  const listeners = new Set();
  const writes = [];
  let resolveRead;
  const context = vm.createContext({
    chrome: { storage: {
      local: {
        get: () => new Promise(resolve => { resolveRead = resolve; }),
        set: async data => { writes.push(data); },
      },
      onChanged: {
        addListener: listener => listeners.add(listener),
        removeListener: listener => listeners.delete(listener),
      },
    } },
  });
  vm.runInContext(script, context);
  return {
    context, api: context.HealthInspectDisplay, writes, listeners,
    resolve: value => resolveRead({ displayMode: value }),
    change: (value, area = "local") => listeners.forEach(listener => listener({ displayMode: { newValue: value } }, area)),
  };
}

test("display choices default to existing floating mode and reject unknown values", async () => {
  const { api, writes } = harness();
  assert.equal(api.parse(undefined), "floating");
  assert.equal(api.parse("inline"), "inline");
  for (const value of ["sidebar", "", null, {}, false]) assert.throws(() => api.parse(value), /invalid/);
  await api.save("inline");
  assert.equal(writes[0].displayMode, "inline");
  await assert.rejects(api.save(undefined), /Choose a display mode/);
  assert.equal(writes.length, 1);
});

test("a stored choice is read once and settings propagate only from local storage", async () => {
  const mock = harness();
  const values = [], errors = [];
  const unsubscribe = mock.api.observe(value => values.push(value), error => errors.push(error));
  mock.resolve("inline");
  await new Promise(resolve => setImmediate(resolve));
  mock.change("floating", "session");
  assert.deepEqual(values, ["inline"]);
  mock.change("floating");
  assert.deepEqual(values, ["inline", "floating"]);
  mock.change("unsupported");
  assert.equal(errors.length, 1);
  mock.change(undefined);
  assert.equal(values.at(-1), "floating");
  unsubscribe();
  assert.equal(mock.listeners.size, 0);
});

test("a late initial storage read cannot override a more recent choice", async () => {
  const mock = harness();
  const values = [];
  mock.api.observe(value => values.push(value), error => { throw error; });
  mock.change("inline");
  mock.resolve("floating");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(values, ["inline"]);
});

test("read and write failures stay visible to the caller", async () => {
  const mock = harness();
  mock.context.chrome.storage.local.get = async () => { throw new Error("Read denied"); };
  mock.context.chrome.storage.local.set = async () => { throw new Error("Write denied"); };
  const errors = [];
  mock.api.observe(() => assert.fail("Failed reads must not pretend to be a saved choice"), error => errors.push(error));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors[0].message, "Read denied");
  await assert.rejects(mock.api.save("inline"), /Write denied/);
  mock.context.chrome.storage.local.get = () => { throw new Error("Extension context invalidated."); };
  mock.api.observe(() => assert.fail("Invalidated contexts must report an error"), error => errors.push(error));
  assert.equal(errors.at(-1).message, "Extension context invalidated.");
});
