import test from "node:test";
import assert from "node:assert/strict";
import { lookup, loadFacility } from "../lib/sources.js";
import { auraContext, plainText } from "../lib/san-mateo.js";
import { summarize } from "../lib/summary.js";

const now = new Date("2026-09-13T15:00:00Z");
const place = { name: "Fixture Town", address: "716 Laurel Street, San Carlos, CA 94070" };
const facility = {
  recordId: "facility-fixture", name: "BLA-FIXTURE", facilityName: "FIXTURE TOWN",
  facilityAddress: "716 LAUREL ST, SAN CARLOS, CA 94070",
  status: "Renewal Approved", visitResult: "Pass",
};
const visit = {
  visitId: "visit-fixture", visitName: "VISIT-1", visitEndDateTime: "2026-01-26",
  visitResult: "Pass", visitOpenViolations: "0",
  visitComment: "<p>Routine inspection.</p><p>Educational notes &amp; observations.</p>",
};
const violation = {
  violationId: "violation-fixture", violationVisitName: "VISIT-1",
  violationRegCodeCitation: "Food shall be rapidly cooled.",
  violationComment: "Food discarded on site.",
  violationComplianceDueDate: "2026-02-25", violationCompliedOnDate: "2026-01-26",
};
const reading = {
  frId: "reading-fixture", frVisitName: "VISIT-1",
  frDescription: "HANDWASHING SINK", frMeasurment: "100 DEGREES F.",
};

function page(version = "framework-fixture") {
  const metadata = {
    mode: "PROD", app: "siteforce:communityApp", fwuid: version,
    loaded: { "APPLICATION@markup://siteforce:communityApp": `application-${version}` },
  };
  return `<html><script src="/s/sfsites/l/${encodeURIComponent(JSON.stringify(metadata))}/inline.js"></script></html>`;
}

function fixtures(overrides = {}) {
  const requests = [];
  let pageReads = 0;
  const options = {
    now,
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://smcehs.my.site.com");
      assert.equal(init.credentials, "omit");
      assert.ok(init.signal instanceof AbortSignal);
      if (init.method === "GET") {
        pageReads++;
        assert.equal(new URL(url).pathname, "/s/inspection-report-search");
        return new Response(overrides.html ?? page(`framework-${pageReads}`));
      }
      assert.equal(init.method, "POST");
      assert.equal(new URL(url).pathname, "/s/sfsites/aura");
      assert.match(init.headers["Content-Type"], /application\/x-www-form-urlencoded/);
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("aura.token"), "null");
      assert.equal(form.get("aura.pageURI"), "/s/inspection-report-search?language=en_US");
      assert.equal(JSON.parse(form.get("aura.context")).fwuid, `framework-${pageReads}`);
      const { actions } = JSON.parse(form.get("message"));
      assert.ok(actions.length <= 6);
      const results = actions.map(action => {
        assert.equal(action.descriptor, "aura://ApexActionController/ACTION$execute");
        assert.equal(action.params.classname, "smcehs_InspectionReportSearchHandler");
        assert.equal(action.params.cacheable, false);
        requests.push(action.params);
        const defaults = {
          getBlaRecordList: [facility], getInspectionRecordList: [visit],
          getViolationRecordList: [violation], getFieldReadingRecordList: [reading],
        };
        const method = action.params.method;
        assert.ok(Object.hasOwn(defaults, method), `Unexpected public method: ${method}`);
        const value = Object.hasOwn(overrides, method) ? overrides[method] : defaults[method];
        return {
          id: action.id, state: "SUCCESS",
          returnValue: { returnValue: typeof value === "function" ? value(action.params.params) : value },
        };
      });
      const payload = { actions: results.reverse() };
      return new Response(JSON.stringify(overrides.response ? overrides.response(payload, actions) : payload));
    },
  };
  return { options, requests, pageReads: () => pageReads };
}

test("San Mateo dynamically loads public metadata, batches anonymous read actions, and preserves record meaning", async () => {
  const mock = fixtures();
  const result = await lookup("sm", place, mock.options);
  assert.equal(result.kind, "records");
  assert.equal(result.county, "sm");
  assert.equal(mock.pageReads(), 1);
  assert.equal(result.facility.exactMatch, true);
  assert.equal(result.facility.applicationNumber, "BLA-FIXTURE");
  assert.equal(result.facility.fiscalStatus, "Renewal Approved");
  assert.deepEqual(mock.requests[0].params, { fN: "", fS: "716", fC: "San Carlos", bN: "", vR: "" });
  assert.equal(mock.requests[1].params.blaId, facility.recordId);
  const inspection = result.inspections[0];
  assert.equal(inspection.result, "Pass");
  assert.equal(inspection.score, null);
  assert.equal(inspection.type, "");
  assert.equal(inspection.openViolationCount, "0");
  assert.equal(inspection.retrievedViolationCount, 1);
  assert.equal(inspection.violationCount, undefined);
  assert.equal(inspection.violations[0].compliedOnDate, "2026-01-26");
  assert.equal(inspection.violations[0].severity, "");
  assert.equal(inspection.fieldReadings[0].measurement, "100 DEGREES F.");
  assert.equal(inspection.notes, "Routine inspection.\nEducational notes & observations.");
  assert.equal(new URL(inspection.url).searchParams.get("applicationId"), facility.recordId);
  assert.match(inspection.sourceLabel, /VISIT-1/);
  assert.equal(result.source.updatedAt, null);
  const summary = summarize(result.inspections);
  assert.ok(summary.statements.some(statement => statement.includes("1 violation entry across 1")));
  assert.ok(!summary.statements.some(statement => statement.includes("Category cited across")));
});

test("framework metadata is refreshed on the next lookup, not hard-coded or persisted", async () => {
  const mock = fixtures();
  await lookup("sm", place, mock.options);
  await lookup("sm", place, mock.options);
  assert.equal(mock.pageReads(), 2);
  assert.equal(auraContext(page("changed-version")).fwuid, "changed-version");
  assert.throws(() => auraContext("<html>Login required</html>"), /metadata was not found/);
  assert.throws(() => auraContext('<script src="/s/sfsites/l/%zz/inline.js">'), /metadata is unreadable/);
});

test("San Mateo keeps fiscal status separate and never substitutes a facility result for missing inspection results", async () => {
  const mock = fixtures({ getInspectionRecordList: [{ ...visit, visitResult: undefined }] });
  const result = await lookup("sm", place, mock.options);
  assert.equal(result.inspections[0].result, "");
  assert.equal(result.facility.fiscalStatus, "Renewal Approved");
  assert.equal(result.inspections[0].score, null);
});

test("successful null lists are empty records, not invented clean inspections", async () => {
  const empty = await lookup("sm", place, fixtures({ getInspectionRecordList: null }).options);
  assert.deepEqual(empty.inspections, []);
  assert.match(summarize(empty.inspections).statements[0], /does not mean.*clean/);
  const missingDetails = await lookup("sm", place, fixtures({
    getViolationRecordList: null, getFieldReadingRecordList: [],
  }).options);
  assert.equal(missingDetails.inspections[0].retrievedViolationCount, 0);
  assert.match(summarize(missingDetails.inspections).statements[1], /empty detail list does not establish/);
  const notFound = await lookup("sm", place, fixtures({ getBlaRecordList: null }).options);
  assert.equal(notFound.kind, "not-found");
  assert.match(notFound.message, /not a clean inspection result/);
});

test("multiple licenses remain alternatives and manual selection is revalidated", async () => {
  const mock = fixtures({ getBlaRecordList: [facility, { ...facility, recordId: "former-license", status: "Expired" }] });
  const ambiguous = await lookup("sm", place, mock.options);
  assert.equal(ambiguous.kind, "candidates");
  assert.equal(ambiguous.candidates.length, 2);
  assert.ok(!mock.requests.some(request => request.method === "getInspectionRecordList"));
  const selected = await loadFacility("sm", ambiguous.candidates[1].candidateKey, place, mock.options);
  assert.equal(selected.confirmed, true);
  assert.equal(selected.facility.id, "former-license");
  assert.equal(mock.requests.find(request => request.method === "getInspectionRecordList").params.blaId, "former-license");
  await assert.rejects(loadFacility("sm", "unrelated-facility", place, mock.options), /no longer in the matching results/);
});

test("San Mateo preserves comma-separated suites, sole candidates, and fuzzy name fallback", async () => {
  const suite = await lookup("sm", place, fixtures({
    getBlaRecordList: [{ ...facility, facilityAddress: "716 LAUREL ST, STE 2, SAN CARLOS, CA 94070" }],
  }).options);
  assert.equal(suite.kind, "records");
  assert.equal(suite.facility.address, "716 LAUREL ST STE 2");
  assert.equal(suite.facility.matchBasis, "single");
  const mock = fixtures({ getBlaRecordList: params => params.fN === "FIXT" ? [facility] : [] });
  const fuzzy = await lookup("sm", { ...place, name: "Fixtuer Town" }, mock.options);
  assert.equal(fuzzy.facility.matchBasis, "similar");
  assert.equal(mock.requests.filter(request => request.method === "getBlaRecordList").length, 3);
  const differentZip = await lookup("sm", place, fixtures({
    getBlaRecordList: [{ ...facility, facilityAddress: "716 LAUREL ST, SAN MATEO, CA 94401" }],
  }).options);
  assert.equal(differentZip.kind, "not-found");
});

test("San Mateo sorts dates, caps history, excludes future visits, and batches only displayed visit details", async () => {
  const history = Array.from({ length: 23 }, (_, index) => ({
    ...visit, visitId: `v${index}`, visitName: `N${index}`,
    visitEndDateTime: `2026-01-${String(index + 1).padStart(2, "0")}`,
  }));
  const mock = fixtures({
    getInspectionRecordList: [...history, { ...visit, visitId: "future", visitEndDateTime: "2031-01-01" }],
    getViolationRecordList: [], getFieldReadingRecordList: [],
  });
  const result = await lookup("sm", place, mock.options);
  assert.equal(result.inspections.length, 20);
  assert.equal(result.inspections[0].date, "2026-01-23");
  assert.equal(result.inspections.at(-1).date, "2026-01-04");
  const details = mock.requests.filter(request => request.params.visitRecId);
  assert.equal(details.length, 40);
  assert.ok(details.every(request => !["future", "v0", "v1", "v2"].includes(request.params.visitRecId)));
  const california = fixtures({ getInspectionRecordList: [{ ...visit, visitEndDateTime: "2026-09-13" }] });
  california.options.now = new Date("2026-09-13T01:00:00Z");
  assert.deepEqual((await lookup("sm", place, california.options)).inspections, []);
});

test("San Mateo schema changes, partial failures, duplicate IDs, and wrong-visit details are errors", async () => {
  const cases = [
    [{ getBlaRecordList: Array.from({ length: 201 }, () => facility) }, /too many records/],
    [{ getBlaRecordList: [{ ...facility, facilityAddress: "Unparseable address" }] }, /unrecognized facility address/],
    [{ getInspectionRecordList: {} }, /unexpected records format/],
    [{ getInspectionRecordList: [{ ...visit, visitEndDateTime: "2026-02-30" }] }, /Invalid calendar date/],
    [{ getInspectionRecordList: [visit, visit] }, /duplicate inspection identifiers/],
    [{ getViolationRecordList: [{ ...violation, violationVisitName: "ANOTHER-VISIT" }] }, /unexpected inspection/],
    [{ getFieldReadingRecordList: [{ ...reading, frVisitName: "ANOTHER-VISIT" }] }, /unexpected inspection/],
    [{ getViolationRecordList: [{ ...violation, violationCompliedOnDate: "2026-02-30" }] }, /Invalid calendar date/],
    [{ response: () => ({ actions: [] }) }, /unexpected Aura response/],
    [{ response: payload => ({ actions: payload.actions.map(action => ({ ...action, returnValue: [] })) }) }, /unexpected Apex response/],
    [{ response: (payload, actions) => actions.some(action => action.params.method === "getViolationRecordList")
      ? { actions: payload.actions.map((action, index) => index ? action : { ...action, state: "ERROR", error: [{ message: "Public source unavailable" }] }) }
      : payload }, /Public source unavailable/],
    [{ response: () => ({ exceptionEvent: true, event: { descriptor: "markup://aura:clientOutOfSync" } }) }, /Retry to refresh/],
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(lookup("sm", place, fixtures(overrides).options), expected);
  }
});

test("county rich text is converted to plain text without executing markup or losing comparisons", () => {
  assert.equal(plainText("<p>Keep &lt;41&#176; F.</p><ol><li>Wash hands.</li><li>Recheck.</li></ol>"),
    "Keep <41\u00b0 F.\n- Wash hands.\n- Recheck.");
  assert.equal(plainText('<script>alert("not executed")</script><p>Inspector&#39;s note &amp; &#x26;.</p>'),
    "Inspector's note & &.");
  assert.equal(plainText("Raw <41 F; &unknown; &#999999999;"), "Raw <41 F; &unknown; &#999999999;");
});
