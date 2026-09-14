import test from "node:test";
import assert from "node:assert/strict";
import { fetchJSON, quoteSoQL, resourceURL } from "../lib/http.js";

test("official data requests omit cookies and have a timeout", async () => {
  const result = await fetchJSON("https://example.org/test-fixture", {
    fetchImpl: async (_url, options) => {
      assert.equal(options.credentials, "omit");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify([{ id: 1 }]));
    },
  });
  assert.deepEqual(result, [{ id: 1 }]);
});

test("HTTP errors, network errors, timeouts, and malformed responses remain errors", async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response("Unavailable", { status: 503 }), /HTTP 503/],
    [async () => { throw new TypeError("Network down"); }, /Could not connect/],
    [async () => { throw new DOMException("Expired", "TimeoutError"); }, /timed out/],
    [async () => new Response("<html>Not JSON</html>"), /unreadable response/],
  ]) await assert.rejects(fetchJSON("https://example.org/test-fixture", { fetchImpl }), expected);
});

test("SoQL string values cannot introduce query operators", () => {
  assert.equal(quoteSoQL("Joe's Cafe"), "'Joe''s Cafe'");
  assert.equal(quoteSoQL("x' OR 1=1 --"), "'x'' OR 1=1 --'");
  const url = new URL(resourceURL("https://example.org/data", { "$where": `name=${quoteSoQL("A&B")}` }));
  assert.equal(url.searchParams.get("$where"), "name='A&B'");
  assert.equal([...url.searchParams.keys()].length, 1);
});
