import { COUNTIES } from "./counties.js";
import { fetchJSON, fetchText, resourceURL } from "./http.js";
import { nameSearchPrefix, normalize, selectMatch, streetKey } from "./matching.js";
import { parseDate, text, todayInCalifornia } from "./source-utils.js";

const ORIGIN = "https://smcehs.my.site.com";
const HISTORY_LIMIT = 20;
const BATCH_SIZE = 6;

export function auraContext(html) {
  for (const match of html.matchAll(/\/s\/sfsites\/l\/([^/"'<>\s]+)\//g)) {
    let metadata;
    try {
      metadata = JSON.parse(decodeURIComponent(match[1]));
    } catch (error) {
      throw new Error("San Mateo's public framework metadata is unreadable. Retry or use the county website.", { cause: error });
    }
    if (metadata?.app === "siteforce:communityApp" && metadata.mode === "PROD"
      && typeof metadata.fwuid === "string" && metadata.fwuid
      && typeof metadata.loaded?.["APPLICATION@markup://siteforce:communityApp"] === "string") {
      return {
        mode: metadata.mode, app: metadata.app, fwuid: metadata.fwuid,
        loaded: { "APPLICATION@markup://siteforce:communityApp": metadata.loaded["APPLICATION@markup://siteforce:communityApp"] },
        dn: [], globals: {}, uad: true,
      };
    }
  }
  throw new Error("San Mateo's public framework metadata was not found. Its website may have changed.");
}

export function plainText(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|ol|ul)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (original, entity) => {
      const key = entity.toLowerCase();
      if (entities[key]) return entities[key];
      const code = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
    }).replace(/\n{3,}/g, "\n\n").trim();
}

function recordList(value, method, limit = 2000) {
  // The county component explicitly treats a successful null return as no records.
  if (value === null) return [];
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`San Mateo returned an unexpected records format for ${method}.`);
  }
  if (value.length > limit) throw new Error(`San Mateo returned too many records for ${method}. Use the county website; results have not been silently truncated.`);
  return value;
}

function facilityFrom(row) {
  const id = text(row, "recordId", true);
  const name = text(row, "facilityName", true);
  const sourceAddress = text(row, "facilityAddress", true);
  const parts = sourceAddress.split(",").map(part => part.trim());
  const stateIndex = parts.findIndex(part => /^CA\b/i.test(part));
  if (stateIndex < 2) throw new Error("San Mateo returned an unrecognized facility address. Use the county website to confirm the location.");
  const address = parts.slice(0, stateIndex - 1).join(" ");
  return {
    id, name, address, sourceAddress, city: parts[stateIndex - 1],
    postalCode: parts[stateIndex].match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || "",
    applicationNumber: text(row, "name"), fiscalStatus: text(row, "status"),
    candidateKey: `${id}|${normalize(name)}|${streetKey(address)}`,
  };
}

function optionalDate(row, field) {
  const value = text(row, field);
  return value ? parseDate(value) : "";
}

function assertVisit(row, field, visitName) {
  if (text(row, field, true) !== visitName) throw new Error("San Mateo returned details for an unexpected inspection.");
}

export function createSanMateoProvider(options = {}) {
  let contextPromise;
  async function execute(calls) {
    contextPromise ||= fetchText(COUNTIES.sm.url, options).then(auraContext);
    const actions = calls.map(([method, params], index) => ({
      id: `${index + 1};a`,
      descriptor: "aura://ApexActionController/ACTION$execute",
      callingDescriptor: "UNKNOWN",
      params: {
        namespace: "", classname: "smcehs_InspectionReportSearchHandler", method, params,
        cacheable: false, isContinuation: false,
      },
    }));
    const body = new URLSearchParams({
      message: JSON.stringify({ actions }),
      "aura.context": JSON.stringify(await contextPromise),
      "aura.pageURI": new URL(COUNTIES.sm.url).pathname + new URL(COUNTIES.sm.url).search,
      "aura.token": "null",
    });
    const payload = await fetchJSON(`${ORIGIN}/s/sfsites/aura?r=1&aura.ApexAction.execute=1`, {
      ...options, method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    });
    if (!Array.isArray(payload?.actions) || payload.actions.length !== actions.length
      || new Set(payload.actions.map(action => action?.id)).size !== actions.length) {
      throw new Error("San Mateo returned an unexpected Aura response. Retry to refresh the public website metadata or use the county website.");
    }
    return actions.map(action => {
      const result = payload.actions.find(item => item?.id === action.id);
      if (result?.state !== "SUCCESS") {
        const detail = Array.isArray(result?.error) ? result.error.map(item => item?.message).filter(Boolean).join("; ").slice(0, 500) : "";
        throw new Error(`San Mateo could not complete ${action.params.method}${detail ? `: ${detail}` : "."} Retry or use the county website.`);
      }
      if (!result.returnValue || !Object.hasOwn(result.returnValue, "returnValue")) {
        throw new Error("San Mateo returned an unexpected Apex response format.");
      }
      return recordList(result.returnValue.returnValue, action.params.method, action.params.method === "getBlaRecordList" ? 200 : 2000);
    });
  }

  async function search(place) {
    const parts = place.address.split(",").map(part => part.trim());
    const stateIndex = parts.findIndex(part => /^(?:CA|California)\b/i.test(part));
    const city = stateIndex > 1 ? parts[stateIndex - 1] : "";
    const number = place.address.trim().match(/^(\d+[A-Za-z]?(?:-\d+)?)\s/)?.[1];
    const queries = [
      ...(number ? [{ fS: number }] : []),
      { fN: place.name },
      ...(nameSearchPrefix(place.name) ? [{ fN: nameSearchPrefix(place.name) }] : []),
    ];
    for (const query of queries) {
      const [found] = await execute([["getBlaRecordList", { fN: "", fS: "", fC: city, bN: "", vR: "", ...query }]]);
      const unique = new Map(found.map(row => {
        const facility = facilityFrom(row);
        return [facility.candidateKey, facility];
      }));
      const ranked = selectMatch(place, [...unique.values()]);
      if (ranked.candidates.length) return ranked;
    }
    return { match: null, candidates: [] };
  }

  async function records(facility) {
    const now = options.now || new Date();
    const today = todayInCalifornia(now);
    const url = resourceURL(`${ORIGIN}/s/inspection-additional-details`, { applicationId: facility.id });
    const [rows] = await execute([["getInspectionRecordList", { blaId: facility.id }]]);
    const all = rows.map(row => ({
      id: text(row, "visitId", true), visitName: text(row, "visitName", true),
      date: parseDate(text(row, "visitEndDateTime", true)),
      type: "", score: null, result: text(row, "visitResult"),
      openViolationCount: text(row, "visitOpenViolations"),
      notes: plainText(text(row, "visitComment")), url,
      sourceLabel: `County inspection history - visit ${text(row, "visitName", true)}`,
      violations: [], fieldReadings: [],
    }));
    if (new Set(all.map(row => row.id)).size !== all.length) throw new Error("San Mateo returned duplicate inspection identifiers.");
    const inspections = all.filter(row => row.date <= today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, HISTORY_LIMIT);
    // Zero open violations can still mean cited violations corrected on site.
    const calls = inspections.flatMap(inspection => [
      ["getViolationRecordList", { visitRecId: inspection.id }],
      ["getFieldReadingRecordList", { visitRecId: inspection.id }],
    ]);
    const details = [];
    for (let offset = 0; offset < calls.length; offset += BATCH_SIZE) {
      details.push(...await execute(calls.slice(offset, offset + BATCH_SIZE)));
    }
    inspections.forEach((inspection, index) => {
      inspection.violations = details[index * 2].map(row => {
        assertVisit(row, "violationVisitName", inspection.visitName);
        return {
          id: text(row, "violationId", true),
          description: plainText(text(row, "violationRegCodeCitation")),
          comment: plainText(text(row, "violationComment")), severity: "",
          complianceDueDate: optionalDate(row, "violationComplianceDueDate"),
          compliedOnDate: optionalDate(row, "violationCompliedOnDate"),
        };
      });
      inspection.retrievedViolationCount = inspection.violations.length;
      inspection.fieldReadings = details[index * 2 + 1].map(row => {
        assertVisit(row, "frVisitName", inspection.visitName);
        return {
          id: text(row, "frId", true), description: plainText(text(row, "frDescription")),
          measurement: plainText(text(row, "frMeasurment")),
        };
      });
    });
    return {
      kind: "records", county: "sm", facility, inspections,
      source: {
        url, retrievedAt: now.toISOString(), updatedAt: null,
        warning: "San Mateo's portal provides visit results, not numerical scores or structured inspection types. Fiscal/license status is not a health rating. Zero open violations does not mean no violations were cited.",
        note: `Chrome reads San Mateo through an official county portal tab opened or reused in the background. Up to ${HISTORY_LIMIT} most recent available inspections are shown; future-dated visits are excluded. Coverage is limited to this portal's records, not the retired historical dataset. Timeline links open the facility history; use the visit number to identify an entry. Routine-only recurrence is not inferred from inspector notes.`,
      },
    };
  }

  return { search, records };
}
