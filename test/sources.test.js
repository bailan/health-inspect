import test from "node:test";
import assert from "node:assert/strict";
import { lookup, loadFacility, parseDate } from "../lib/sources.js";

const now = new Date("2026-09-13T15:00:00Z");
const sfPlace = { name: "Fixture Bakery", address: "600 Guerrero Street, San Francisco, CA 94110" };
const sfFacility = { permit_number: "fixture-sf", dba: "FIXTURE BAKERY", street_address: "600 GUERRERO ST", street_address_clean: "600 GUERRERO ST" };
const scPlace = { name: "Fixture Bagels", address: "5231 Stevens Creek Boulevard, Santa Clara, CA 95051" };
const scFacility = { business_id: "fixture-sc", name: "FIXTURE BAGELS", address: "5231 STEVENS CREEK BL", city: "SANTA CLARA", postal_code: "95051" };

function options(handler) {
  return { now, fetchImpl: async url => new Response(JSON.stringify(await handler(new URL(url)))) };
}

test("SF preserves combined violation prose and status without inventing a score", async () => {
  const result = await lookup("sf", sfPlace, options(url => {
    const select = url.searchParams.get("$select") || "";
    if (select.startsWith("distinct")) return [sfFacility];
    if (select.includes("max")) return [{ updated_at: "2026-09-12T00:00:00.000" }];
    assert.match(url.searchParams.get("$where"), /inspection_date <= '2026-09-13T23:59:59'/);
    return [{
      ...sfFacility, inspection_date: "2025-02-18T00:00:00.000", inspection_type: "Routine",
      facility_rating_status: "Pass", violation_count: "2",
      violation_codes: "Code A, B: a single explanatory sentence, with commas.",
      data_as_of: "2025-07-01T00:00:00.000",
    }];
  }));
  assert.equal(result.kind, "records");
  assert.equal(result.inspections[0].score, null);
  assert.equal(result.inspections[0].result, "Pass");
  assert.equal(result.inspections[0].violationCount, "2");
  assert.equal(result.inspections[0].violations.length, 0);
  assert.match(result.inspections[0].violationText, /with commas/);
  assert.equal(result.source.updatedAt, "2026-09-12");
});

test("Santa Clara joins the source's misspelled inspection ID and preserves observations", async () => {
  const result = await lookup("sc", scPlace, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    if (url.pathname.includes("2u2d")) return [{
      business_id: "fixture-sc", inpsection_id: "inspection-fixture", date: "20260911",
      score: "95", result: "G", type: "ROUTINE INSPECTION",
    }];
    assert.match(url.searchParams.get("$where"), /inspection_id in \('inspection-fixture'\)/);
    return [{ inspection_id: "inspection-fixture", description: "Category title", violation_comment: "Full observation with important qualifications.", critical: false }];
  }));
  assert.equal(result.kind, "records");
  assert.equal(result.inspections[0].date, "2026-09-11");
  assert.equal(result.inspections[0].score, "95");
  assert.equal(result.inspections[0].result, "Pass (Green)");
  assert.equal(result.inspections[0].violations[0].severity, "Non-critical");
  assert.match(result.inspections[0].violations[0].comment, /qualifications/);
});

test("empty inspection histories are allowed but missing source schemas fail explicitly", async () => {
  const result = await lookup("sc", scPlace, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    return [];
  }));
  assert.equal(result.inspections.length, 0);
  await assert.rejects(lookup("sc", scPlace, options(() => [{ wrong: "schema" }])), /missing.*business_id/);
  await assert.rejects(lookup("sf", sfPlace, options(() => ({ error: "wrong format" }))), /unexpected records format/);
});

test("missing scores remain absent and unknown official results remain verbatim", async () => {
  const result = await lookup("sc", scPlace, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility];
    if (url.pathname.includes("itys")) return [];
    if (url.pathname.includes("2u2d")) return url.searchParams.get("$where").includes("upper(type)")
      ? [] : [{ business_id: "fixture-sc", inpsection_id: "i", date: "20260911", result: "NEW_CODE", type: "REINSPECTION" }];
    return [];
  }));
  assert.equal(result.inspections[0].score, null);
  assert.equal(result.inspections[0].result, "NEW_CODE");
  assert.equal(result.source.updatedAt, null);
  assert.equal(result.latestRoutineInspection, null);
});

test("Santa Clara headline score comes from the latest routine even beyond the recent history limit", async () => {
  const routine = {
    business_id: "fixture-sc", inpsection_id: "routine-score", date: "20250801",
    type: "ROUTINE INSPECTION", score: "92", result: "G",
  };
  const recent = Array.from({ length: 20 }, (_, index) => ({
    business_id: "fixture-sc", inpsection_id: `followup-${index}`,
    date: `202609${String(12 - Math.floor(index / 2)).padStart(2, "0")}`,
    type: "REINSPECTION", result: "G",
  }));
  const result = await lookup("sc", scPlace, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    if (url.pathname.includes("2u2d")) {
      if (url.searchParams.get("$where").includes("upper(type)")) {
        assert.equal(url.searchParams.get("$limit"), "1");
        assert.equal(url.searchParams.get("$order"), "date DESC");
        assert.match(url.searchParams.get("$where"), /date <= '20260913'/);
        return [routine];
      }
      return recent;
    }
    return [];
  }));
  assert.equal(result.county, "sc");
  assert.equal(result.inspections.length, 20);
  assert.equal(result.inspections[0].score, null);
  assert.equal(result.latestRoutineInspection.score, "92");
  assert.equal(result.latestRoutineInspection.date, "2025-08-01");
  assert.match(result.latestRoutineInspection.url, /inpsection_id=routine-score/);
});

test("missing latest routine score is not replaced by an older routine or follow-up score", async () => {
  const latest = { business_id: "fixture-sc", inpsection_id: "latest-routine", date: "20260910", type: "ROUTINE INSPECTION" };
  const result = await lookup("sc", scPlace, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility];
    if (url.pathname.includes("itys")) return [];
    if (url.pathname.includes("2u2d")) return url.searchParams.get("$where").includes("upper(type)") ? [latest] : [
      { ...latest, inpsection_id: "follow-up", type: "REINSPECTION", date: "20260911", score: "100" },
      latest,
      { ...latest, inpsection_id: "older-routine", date: "20250801", score: "92" },
    ];
    return [];
  }));
  assert.equal(result.latestRoutineInspection.score, null);
  assert.equal(result.latestRoutineInspection.id, "latest-routine");
});

test("ambiguous facilities require a current candidate token before loading", async () => {
  const opts = options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility, { ...scFacility, business_id: "other-fixture" }];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    return [];
  });
  const result = await lookup("sc", scPlace, opts);
  assert.equal(result.kind, "candidates");
  assert.equal(result.candidates.length, 2);
  assert.equal((await loadFacility("sc", result.candidates[0].candidateKey, scPlace, opts)).confirmed, true);
  await assert.rejects(loadFacility("sc", "unrelated-id", scPlace, opts), /no longer in the matching results/);
});

test("confident automatic matches retain alternative facilities for correction", async () => {
  const opts = options(url => {
    if (url.pathname.includes("vuw7")) return [
      scFacility,
      { ...scFacility, business_id: "former-tenant", name: "FORMER TENANT CAFE" },
    ];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    return [];
  });
  const automatic = await lookup("sc", scPlace, opts);
  assert.equal(automatic.kind, "records");
  assert.equal(automatic.facility.id, "fixture-sc");
  assert.equal(automatic.candidates.length, 2);
  const alternate = automatic.candidates.find(candidate => candidate.id === "former-tenant");
  const selected = await loadFacility("sc", alternate.candidateKey, scPlace, opts);
  assert.equal(selected.facility.id, "former-tenant");
  assert.equal(selected.confirmed, true);
  assert.equal(selected.candidates.length, 2);
  assert.equal((await lookup("sc", scPlace, opts)).facility.id, "fixture-sc");
});

test("a sole candidate with different name or suite loads records without confirmation", async () => {
  for (const facility of [
    { ...scFacility, name: "FIXTURE BAGELS & CAFE" },
    { ...scFacility, address: "5231 STEVENS CREEK BL STE 2" },
  ]) {
    const result = await lookup("sc", scPlace, options(url => {
      if (url.pathname.includes("vuw7")) return [facility];
      if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
      return [];
    }));
    assert.equal(result.kind, "records");
    assert.equal(result.facility.id, facility.business_id);
    assert.equal(result.facility.exactMatch, false);
    assert.equal(result.candidates.length, 1);
    assert.notEqual(result.confirmed, true);
  }
});

test("source dates are validated and future dates cannot become latest", async () => {
  assert.equal(parseDate("20260911"), "2026-09-11");
  assert.throws(() => parseDate("20260230"), /Invalid calendar date/);
  assert.throws(() => parseDate("not a date"), /Invalid inspection date/);
  await assert.rejects(lookup("sf", sfPlace, options(url => {
    if (url.searchParams.get("$select")?.startsWith("distinct")) return [sfFacility];
    if (url.searchParams.get("$select")?.includes("max")) return [];
    return [{ ...sfFacility, inspection_date: "2031-05-16T00:00:00.000" }];
  })), /future-dated/);
});

test("a unique fuzzy candidate loads before asking the user and retains alternatives", async () => {
  const result = await lookup("sc", { ...scPlace, name: "Fixtuer Bagels" }, options(url => {
    if (url.pathname.includes("vuw7")) return [scFacility, { ...scFacility, business_id: "other", name: "Unrelated Cafe" }];
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    return [];
  }));
  assert.equal(result.kind, "records");
  assert.equal(result.facility.matchBasis, "similar");
  assert.equal(result.candidates.length, 2);
});

test("partial name discovery is a fallback after exact discovery and still requires local matching", async () => {
  const queries = [];
  const result = await lookup("sc", { ...scPlace, name: "Fixtuer Bagels" }, options(url => {
    if (url.pathname.includes("vuw7")) {
      const query = url.searchParams.get("$where");
      queries.push(query);
      return query.includes("upper(name) like '%FIXT%'")
        ? [{ ...scFacility, address: "5231-STEVENS CREEK BL" }] : [];
    }
    if (url.pathname.includes("itys")) return [{ feed_date: "20260912" }];
    return [];
  }));
  assert.equal(queries.length, 3);
  assert.match(queries[0], /upper\(address\)/);
  assert.match(queries[1], /upper\(name\)='FIXTUER BAGELS'/);
  assert.equal(result.kind, "records");
  assert.equal(result.facility.matchBasis, "similar");
});

test("lookup escapes names and returns explicit no-match instead of another location", async () => {
  let nameQuery;
  const result = await lookup("sf", { name: "Joe's Cafe", address: "99 Other St, San Francisco, CA" }, options(url => {
    if (url.searchParams.get("$where").includes("upper(dba)")) nameQuery = url.searchParams.get("$where");
    return [];
  }));
  assert.equal(result.kind, "not-found");
  assert.match(nameQuery, /JOE''S CAFE/);
  await assert.rejects(lookup("__proto__", sfPlace), /supported county/);
});
