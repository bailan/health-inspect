import test from "node:test";
import assert from "node:assert/strict";
import "../lib/maps-context.js";
import { selectMatch, streetKey, nameSimilarity, addressSimilarity } from "../lib/matching.js";
import { summarize, isRoutineInspection } from "../lib/summary.js";
import { inferCounty } from "../lib/county-detection.js";

const place = { name: "Example Cafe", address: "123 Main Street, San Francisco, CA 94103", key: "test" };
const facility = { id: "1", name: "Example Cafe", address: "123 Main St", postalCode: "94103" };

test("county detection uses city components, not similar city or street names", () => {
  assert.equal(inferCounty("1 Main St, South San Francisco, CA 94080"), "sm");
  assert.equal(inferCounty("1 Main St, San Francisco, CA"), "sf");
  assert.equal(inferCounty("1 Main St, Palo Alto, CA"), "sc");
  assert.equal(inferCounty("1 Main St, East Palo Alto, CA"), "sm");
  assert.equal(inferCounty("1 San Francisco St, Oakland, CA"), null);
  assert.equal(inferCounty("1 Main St, San Jose, Other Country"), null);
  assert.equal(inferCounty("1 Main St, San Jose CA 95113"), "sc");
  assert.equal(inferCounty("1 Main St\nSan Mateo\nCalifornia 94401"), "sm");
  assert.equal(inferCounty("1 Main St, San Jos\u00e9, California 95113-1234, USA"), "sc");
  assert.equal(inferCounty("1 Main St, Suite 2, North Fair Oaks, CA 94025"), "sm");
  assert.equal(inferCounty("1 Main St, Santa Clara County, CA"), "sc");
  assert.equal(inferCounty("1 Main St, San Francisco, Oakland, CA"), null);
  assert.equal(inferCounty("1 Main St, San Jose, IL 61854"), null);
  assert.equal(inferCounty("1 Main St, CA 94103"), null);
  assert.equal(inferCounty("1 Main St, Unknown City, CA 94000"), null);
});

test("Maps context requires consistent URL, title and street address", () => {
  const snapshot = { url: "https://www.google.com/maps/place/Example+Cafe/data=x", name: place.name, address: `Address: ${place.address}`, category: "Cafe" };
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot(snapshot).address, place.address);
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ ...snapshot, name: "Previous Restaurant" }), null);
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ ...snapshot, address: "" }), null);
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ ...snapshot, url: "https://www.google.com/maps/search/restaurants" }), null);
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ ...snapshot, url: "https://evil.test/maps/place/Example+Cafe" }), null);
});

test("malformed Maps URLs do not crash extraction", () => {
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ url: "bad", category: "Restaurant" }), null);
  assert.equal(globalThis.HealthInspectMaps.contextFromSnapshot({ url: "https://www.google.com/maps/place/%ZZ", name: "x", address: "1 Road", category: "Restaurant" }), null);
});

test("food eligibility uses Maps categories, not business names or loose substrings", () => {
  const { isFoodCategory, contextFromSnapshot } = globalThis.HealthInspectMaps;
  for (const category of ["Restaurant", "Vietnamese restaurant", "Fast food restaurant", "Caf\u00e9", "Bakery", "Coffee shop", "Bar & grill", "Ice cream shop"]) {
    assert.equal(isFoodCategory(category), true, category);
  }
  for (const category of ["Hotel", "Park", "Bank", "Grocery store", "Restaurant supply store", "Coffee machine supplier", "Food bank", "Bar", "", undefined, null]) {
    assert.equal(isFoodCategory(category), false, String(category));
    assert.equal(contextFromSnapshot({
      url: "https://www.google.com/maps/place/Example+Cafe/", name: "Example Cafe",
      address: place.address, category,
    }), null);
  }
});

test("exact name and normalized street address auto-match", () => {
  assert.equal(streetKey("123 Main Street"), "123 main st");
  assert.equal(selectMatch(place, [facility]).match.id, "1");
});

test("multiple same-name branches and conflicting postcodes do not auto-match", () => {
  assert.equal(selectMatch(place, [
    { ...facility, address: "456 Main St" },
    { ...facility, id: "2", address: "789 Main St" },
  ]).match, null);
  assert.equal(selectMatch(place, [{ ...facility, postalCode: "94000" }]).match, null);
});

test("duplicate facilities require confirmation, but sole non-exact candidates load automatically", () => {
  assert.equal(selectMatch(place, [facility, { ...facility, id: "2" }]).match, null);
  for (const candidate of [
    { ...facility, address: "123 Main St Ste 2" },
    { ...facility, city: "Oakland" },
    { ...facility, name: "Former Tenant" },
  ]) {
    const result = selectMatch(place, [candidate]);
    assert.equal(result.match.id, candidate.id);
    assert.equal(result.match.exactMatch, false);
  }
  assert.equal(streetKey("123 Main Street #2"), streetKey("123 Main St STE #2"));
});

test("summaries count recurrence once per routine inspection, excluding followups", () => {
  const issue = { description: "Temperature control", severity: "High" };
  const records = [
    { date: "2024-01-01", type: "Routine - Unscheduled", score: 88, violations: [issue, issue] },
    { date: "2024-01-10", type: "Reinspection", score: null, violations: [issue] },
    { date: "2025-01-01", type: "Routine - Unscheduled", score: 90, violations: [issue] },
  ];
  const summary = summarize(records);
  assert.equal(summary.latest.score, 90);
  assert.ok(summary.statements.some(text => text.includes("2 retrieved routine inspections")));
  assert.ok(!summary.statements.some(text => /corrected|safe to eat/i.test(text)));
});

test("fuzzy names tolerate small typos and word order while exact matches win", () => {
  assert.ok(nameSimilarity("Tartnie Bakery", "Tartine Bakery") >= 0.85);
  assert.equal(nameSimilarity("The Golden Dragon", "Dragon Golden"), 1);
  const typo = { ...facility, name: "Exampel Cafe" };
  const unrelated = { ...facility, id: "other", name: "Completely Different Bakery" };
  const result = selectMatch(place, [typo, unrelated]);
  assert.equal(result.match.id, facility.id);
  assert.equal(result.match.exactMatch, false);
  assert.equal(result.match.matchBasis, "similar");
  assert.equal(selectMatch(place, [typo, { ...facility, id: "exact" }]).match.id, "exact");
});

test("fuzzy streets never equate different building numbers or units", () => {
  assert.ok(addressSimilarity("5231 Stevnes Creek Boulevard", "5231 Stevens Creek BL") >= 0.9);
  assert.equal(addressSimilarity("5232 Stevens Creek Blvd", "5231 Stevens Creek Blvd"), 0);
  assert.equal(addressSimilarity("5231 Stevens Creek Blvd #2", "5231 Stevens Creek Blvd #3"), 0);
  assert.equal(addressSimilarity("5231 Stevens Creek Blvd", "5231 Stevens Creek Blvd #2"), 0);
  const options = [
    { id: "near", name: "House of Bagels", address: "5231 Stevens Creek BL", postalCode: "95051" },
    { id: "other", name: "Unrelated Cafe", address: "5231 Other St", postalCode: "95051" },
  ];
  const result = selectMatch({ name: "House of Bagels", address: "5231 Stevnes Creek Blvd, Santa Clara, CA 95051" }, options);
  assert.equal(result.match.matchBasis, "similar");
  assert.equal(result.match.id, "near");
});

test("multiple plausible fuzzy matches still require a choice", () => {
  const result = selectMatch(place, [
    { ...facility, name: "Exampel Cafe", id: "one" },
    { ...facility, name: "Example Caffe", id: "two" },
  ]);
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 2);
});

test("missing inspections never imply a clean history", () => {
  assert.match(summarize([]).statements[0], /does not mean.*clean/);
});

test("routine classification excludes follow-ups and non-routine inspections", () => {
  for (const type of ["Routine", "ROUTINE INSPECTION", "Routine - Unscheduled"]) assert.equal(isRoutineInspection(type), true);
  for (const type of ["Non-routine", "Reinspection", "Routine reinspection", "Routine follow-up", undefined]) assert.equal(isRoutineInspection(type), false);
});
