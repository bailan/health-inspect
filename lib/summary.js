export function isRoutineInspection(type) {
  return typeof type === "string" && /^routine(?:\s+inspection)?(?:\s*[-:]\s*(?:scheduled|unscheduled))?$/i.test(type.trim());
}

export function summarize(inspections) {
  const sorted = [...inspections].sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) return { latest: null, statements: ["No inspection entries were returned. This does not mean the facility has a clean record."] };
  const latest = sorted[0];
  const statements = [`${sorted.length} inspection ${sorted.length === 1 ? "entry" : "entries"} in the retrieved records (${sorted.at(-1).date} to ${latest.date}).`];
  if (sorted.every(item => Number.isInteger(item.retrievedViolationCount))) {
    const count = sorted.reduce((total, item) => total + item.retrievedViolationCount, 0);
    const visits = sorted.filter(item => item.retrievedViolationCount > 0).length;
    statements.push(`The portal returned ${count} violation ${count === 1 ? "entry" : "entries"} across ${visits} of these inspections. Entries can include corrected violations; an empty detail list does not establish that no violations were cited.`);
  }
  const routine = sorted.filter(item => isRoutineInspection(item.type));
  const occurrences = new Map();
  for (const inspection of routine) {
    const unique = new Set(inspection.violations.map(item => item.description?.trim()).filter(Boolean));
    for (const description of unique) occurrences.set(description, (occurrences.get(description) || 0) + 1);
  }
  const recurring = [...occurrences.entries()].filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [description, count] of recurring) {
    statements.push(`Category cited across ${count} retrieved routine inspections: ${description}. Read each inspector's observations in the timeline.`);
  }
  statements.push("Inspection records describe conditions on their inspection dates, not current food safety or operating status.");
  return { latest, statements };
}
