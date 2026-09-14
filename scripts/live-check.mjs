import assert from "node:assert/strict";
import { lookup } from "../lib/sources.js";
import { isRoutineInspection } from "../lib/summary.js";

const examples = [
  ["sf", { name: "Tartine Bakery", address: "600 Guerrero Street, San Francisco, CA 94110" }],
  ["sc", { name: "House of Bagels", address: "5231 Stevens Creek Boulevard, Santa Clara, CA 95051" }],
  ["sm", { name: "Town", address: "716 Laurel Street, San Carlos, CA 94070" }],
];
await Promise.all(examples.map(async ([county, place]) => {
  const result = await lookup(county, place);
  assert.equal(result.kind, "records", `${county}: expected an exact matched facility`);
  assert.ok(result.inspections.length > 0, `${county}: expected real inspection records`);
  assert.equal(result.facility.exactMatch, true, `${county}: expected exact name/address matching`);
  if (county !== "sm") assert.ok(result.source.updatedAt, `${county}: expected source freshness`);
  else {
    assert.equal(result.facility.id, "0f08y0000000NS9AAM");
    assert.equal(result.source.updatedAt, null);
    assert.ok(result.inspections.every(inspection => inspection.score === null));
    assert.ok(result.inspections.every(inspection => inspection.retrievedViolationCount === inspection.violations.length));
    assert.ok(result.inspections.some(inspection => inspection.fieldReadings.length > 0));
    assert.equal(new URL(result.source.url).searchParams.get("applicationId"), result.facility.id);
  }
  if (county === "sc") {
    const routine = result.latestRoutineInspection;
    assert.ok(routine && isRoutineInspection(routine.type), "sc: expected the latest routine inspection");
    assert.notEqual(routine.score, null, "sc: expected a numerical score for this live example");
    const recentRoutine = result.inspections.find(inspection => isRoutineInspection(inspection.type));
    if (recentRoutine) assert.equal(routine.id, recentRoutine.id, "sc: score must use the newest routine visit");
    console.log(`sc: routine score ${routine.score}, inspected ${routine.date}`);
  }
  console.log(`${county}: matched ${result.facility.id}; ${result.inspections.length} inspections; latest ${result.inspections[0].date}; source updated ${result.source.updatedAt}`);
}));
