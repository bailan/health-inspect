export function text(row, field, required = false) {
  const value = row[field];
  if (value == null || value === "") {
    if (required) throw new Error(`The official source is missing its ${field} field. Its schema may have changed.`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Unexpected ${field} field in the official source.`);
  return String(value).trim();
}

export function parseDate(value) {
  const formatted = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(formatted)) throw new Error("Invalid inspection date in the official source.");
  const date = new Date(`${formatted}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== formatted) throw new Error("Invalid calendar date in the official source.");
  return formatted;
}

export function todayInCalifornia(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
