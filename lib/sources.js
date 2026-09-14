import { COUNTIES } from "./counties.js";
import { fetchJSON, quoteSoQL, resourceURL } from "./http.js";
import { nameSearchPrefix, normalize, selectMatch, streetKey } from "./matching.js";
import { isRoutineInspection } from "./summary.js";
import { parseDate, text, todayInCalifornia } from "./source-utils.js";
import { createSanMateoProvider } from "./san-mateo.js";

export { parseDate } from "./source-utils.js";

const HISTORY_LIMIT = 20;
const SEARCH_LIMIT = 200;

function countyFor(id) {
  if (!Object.hasOwn(COUNTIES, id)) throw new Error("Choose a supported county.");
  return COUNTIES[id];
}

async function rows(base, parameters, options) {
  const data = await fetchJSON(resourceURL(base, parameters), options);
  if (!Array.isArray(data) || data.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("The official data source returned an unexpected records format.");
  }
  return data;
}

function candidate(row, countyId) {
  const sf = countyId === "sf";
  const id = text(row, sf ? "permit_number" : "business_id", true);
  const name = text(row, sf ? "dba" : "name", true);
  const address = (sf && text(row, "street_address_clean")) || text(row, sf ? "street_address" : "address", true);
  return {
    id, name, address, city: sf ? "San Francisco" : text(row, "city"),
    sourceAddress: sf ? text(row, "street_address", true) : address,
    postalCode: sf ? "" : text(row, "postal_code"),
    candidateKey: `${id}|${normalize(name)}|${streetKey(address)}`,
  };
}

async function searchFacilities(countyId, place, options) {
  const county = countyFor(countyId);
  const sf = countyId === "sf";
  const nameField = sf ? "dba" : "name";
  const addressField = sf ? "street_address" : "address";
  const number = place.address.trim().match(/^(\d+[A-Za-z]?(?:-\d+)?)\s/)?.[1];
  const parameters = {
    "$limit": SEARCH_LIMIT + 1,
    ...(sf ? { "$select": "distinct permit_number,dba,street_address,street_address_clean" } : {}),
  };
  const endpoint = sf ? county.inspections : county.facilities;
  const rankFound = found => {
    const unique = new Map(found.map(row => {
      const facility = candidate(row, countyId);
      return [facility.candidateKey, facility];
    }));
    return selectMatch(place, [...unique.values()]);
  };
  let found = [];
  if (number) {
    found = await rows(endpoint, { ...parameters, "$where": `upper(${addressField}) like ${quoteSoQL(`${number.toUpperCase()} %`)}` }, options);
  }
  if (found.length > SEARCH_LIMIT) throw new Error("Too many facilities share this street number. Use the official county search to confirm the location.");
  let ranked = rankFound(found);
  if (!ranked.candidates.length) {
    const exactName = `upper(${nameField})=${quoteSoQL(place.name.toUpperCase())}`;
    found = await rows(endpoint, { ...parameters, "$where": exactName }, options);
    if (found.length > SEARCH_LIMIT) throw new Error("Too many facilities match this business name. Use the official county search to confirm the location.");
    ranked = rankFound(found);
  }
  if (!ranked.candidates.length) {
    const prefix = nameSearchPrefix(place.name);
    if (prefix) {
      found = await rows(endpoint, {
        ...parameters, "$where": `upper(${nameField}) like ${quoteSoQL(`%${prefix}%`)}`,
      }, options);
      if (found.length > SEARCH_LIMIT) throw new Error("Too many facilities match this partial name. Use the official county search to confirm the location.");
      ranked = rankFound(found);
    }
  }
  return ranked;
}

function sourceInfo(county, now, updatedAt, warning) {
  return {
    url: county.url,
    dataset: county.dataset,
    retrievedAt: now.toISOString(),
    updatedAt,
    warning,
    note: `Up to ${HISTORY_LIMIT} most recent available inspections are shown. Future-dated entries are excluded. This feed may lag the county's report website.`,
  };
}

async function sfRecords(facility, options) {
  const county = COUNTIES.sf;
  const now = options.now || new Date();
  const today = todayInCalifornia(now);
  const filter = `permit_number=${quoteSoQL(facility.id)} and inspection_date <= ${quoteSoQL(`${today}T23:59:59`)}`;
  const [records, freshness] = await Promise.all([
    rows(county.inspections, {
      "$where": `${filter} and (street_address=${quoteSoQL(facility.sourceAddress)} or street_address_clean=${quoteSoQL(facility.address)})`,
      "$order": "inspection_date DESC", "$limit": HISTORY_LIMIT + 1,
    }, options),
    rows(county.inspections, { "$select": "max(data_as_of) as updated_at" }, options),
  ]);
  const seen = new Set();
  const inspections = records.map(row => {
    const date = parseDate(text(row, "inspection_date", true));
    if (date > today) throw new Error("The official source returned a future-dated inspection despite the date filter.");
    if (text(row, "permit_number", true) !== facility.id) throw new Error("The source returned inspections for a different facility.");
    return {
      date, type: text(row, "inspection_type"), score: null,
      result: text(row, "facility_rating_status"),
      violationCount: text(row, "violation_count"),
      violationText: text(row, "violation_codes"),
      notes: text(row, "inspection_notes"),
      suspensionNotes: text(row, "suspension_notes"),
      dataAsOf: text(row, "data_as_of"),
      violations: [],
      url: resourceURL(county.inspections, { "$where": `permit_number=${quoteSoQL(facility.id)} and inspection_date=${quoteSoQL(text(row, "inspection_date", true))}` }),
    };
  }).filter(record => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, HISTORY_LIMIT);
  const updatedAt = freshness[0]?.updated_at ? parseDate(text(freshness[0], "updated_at")) : null;
  return {
    kind: "records", facility, inspections,
    source: sourceInfo(county, now, updatedAt,
      "San Francisco's current feed reports Pass / Conditional Pass / Closure, not numerical scores. Violation text is shown verbatim; combined text is not split or used to infer recurring individual violations."),
  };
}

function scInspection(row, facility, today) {
  const id = text(row, "inpsection_id", true);
  const date = parseDate(text(row, "date", true));
  if (date > today) throw new Error("The official source returned a future-dated inspection despite the date filter.");
  if (text(row, "business_id", true) !== facility.id) throw new Error("The source returned inspections for a different facility.");
  const result = text(row, "result");
  const labels = { G: "Pass (Green)", Y: "Conditional Pass (Yellow)", R: "Closure (Red)" };
  return {
    id, date, type: text(row, "type"), score: text(row, "score") || null,
    result: labels[result] || result,
    notes: text(row, "inspection_comment"),
    url: resourceURL(COUNTIES.sc.inspections, { inpsection_id: id }),
    violationsUrl: resourceURL(COUNTIES.sc.violations, { inspection_id: id }),
  };
}

async function scRecords(facility, options) {
  const county = COUNTIES.sc;
  const now = options.now || new Date();
  const today = todayInCalifornia(now);
  const filter = `business_id=${quoteSoQL(facility.id)} and date <= ${quoteSoQL(today.replaceAll("-", ""))}`;
  const [records, routineRecords, freshness] = await Promise.all([
    rows(county.inspections, {
      "$where": filter,
      "$order": "date DESC", "$limit": HISTORY_LIMIT,
    }, options),
    rows(county.inspections, {
      "$where": `${filter} and upper(type) in ('ROUTINE INSPECTION','ROUTINE')`,
      "$order": "date DESC", "$limit": 1,
    }, options),
    rows(county.freshness, { "$limit": 1 }, options),
  ]);
  if (routineRecords.length > 1) throw new Error("The source returned more than one latest routine inspection.");
  const latestRoutineInspection = routineRecords.length ? scInspection(routineRecords[0], facility, today) : null;
  if (latestRoutineInspection && !isRoutineInspection(latestRoutineInspection.type)) {
    throw new Error("The source returned a non-routine inspection for the routine score query.");
  }
  const inspectionIds = [...new Set(records.map(row => text(row, "inpsection_id", true)))];
  const violations = inspectionIds.length ? await rows(county.violations, {
    "$where": `inspection_id in (${inspectionIds.map(quoteSoQL).join(",")})`, "$limit": 2001,
  }, options) : [];
  if (violations.length > 2000) throw new Error("The source returned too many violation entries to show a complete history. Use the county report website.");
  const byInspection = new Map(inspectionIds.map(id => [id, []]));
  for (const row of violations) {
    const list = byInspection.get(text(row, "inspection_id", true));
    if (!list) throw new Error("The source returned violations for an unexpected inspection.");
    if (row.critical != null && typeof row.critical !== "boolean") throw new Error("The source returned an unexpected critical-violation classification.");
    list.push({
      code: text(row, "code"),
      description: text(row, "description"),
      comment: text(row, "violation_comment"),
      severity: row.critical === true ? "Critical" : row.critical === false ? "Non-critical" : "",
    });
  }
  const inspections = records.map(row => {
    const inspection = scInspection(row, facility, today);
    return { ...inspection, violations: byInspection.get(inspection.id) };
  });
  if (inspectionIds.length !== records.length) throw new Error("The official source returned duplicate inspection identifiers. Use the county website to confirm the history.");
  const updatedAt = freshness[0]?.feed_date ? parseDate(text(freshness[0], "feed_date")) : null;
  return {
    kind: "records", county: "sc", facility, inspections, latestRoutineInspection,
    source: sourceInfo(county, now, updatedAt, "Santa Clara's numerical score and placard result are separate measures. A historical closure result does not establish that a business is currently closed."),
  };
}

function providerFor(countyId, options) {
  if (countyId === "sm") return createSanMateoProvider(options);
  return {
    search: place => searchFacilities(countyId, place, options),
    records: facility => countyId === "sf" ? sfRecords(facility, options) : scRecords(facility, options),
  };
}

export async function lookup(countyId, place, options = {}) {
  const county = countyFor(countyId);
  const provider = providerFor(countyId, options);
  const { match, candidates } = await provider.search(place);
  if (match) return { ...await provider.records(match), candidates };
  if (!candidates.length) return {
    kind: "not-found",
    message: "No confident matching facility was found in this county's public feed. The business may use another name, be newly opened, or be outside this feed's coverage. This is not a clean inspection result.",
    url: county.url,
  };
  return {
    kind: "candidates", candidates,
    message: "Confirm the facility below. Name, street address, or unit details differ, or more than one facility could match. Historical businesses at the same address may have different ownership.",
    url: county.url,
  };
}

export async function loadFacility(countyId, candidateKey, place, options = {}) {
  countyFor(countyId);
  if (typeof candidateKey !== "string" || candidateKey.length > 1000) throw new Error("Invalid facility selection.");
  const provider = providerFor(countyId, options);
  const { candidates } = await provider.search(place);
  const facility = candidates.find(item => item.candidateKey === candidateKey);
  if (!facility) throw new Error("The selected facility is no longer in the matching results. Retry the restaurant lookup.");
  return { ...await provider.records(facility), confirmed: true, candidates };
}
