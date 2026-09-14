export function normalize(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function nameSearchPrefix(name) {
  const generic = new Set(["restaurant", "cafe", "bakery", "coffee", "shop", "grill"]);
  const token = normalize(name).split(" ").filter(word => word.length >= 4 && !generic.has(word))
    .sort((a, b) => b.length - a.length)[0];
  return token?.slice(0, 4).toUpperCase();
}

export function streetKey(address) {
  const street = normalize(String(address).split(",")[0].replace(/(?:\b(?:suite|ste)\.?\s*)?#\s*/gi, " ste "));
  const aliases = { street: "st", avenue: "ave", av: "ave", boulevard: "blvd", bl: "blvd", road: "rd", drive: "dr", lane: "ln", court: "ct", highway: "hwy", suite: "ste", unit: "ste", parkway: "pkwy", terrace: "ter", place: "pl", circle: "cir", expressway: "expy", north: "n", south: "s", east: "e", west: "w" };
  return street.split(" ").map(word => aliases[word] || word).join(" ");
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious;
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(left[i - 1] !== right[j - 1]));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous;
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

export function nameSimilarity(left, right) {
  const first = normalize(left).replace(/^the /, "").replace(/ (llc|inc|incorporated)$/, "");
  const second = normalize(right).replace(/^the /, "").replace(/ (llc|inc|incorporated)$/, "");
  return Math.max(similarity(first, second),
    similarity(first.split(" ").sort().join(" "), second.split(" ").sort().join(" ")));
}

export function addressSimilarity(left, right) {
  const first = streetKey(left);
  const second = streetKey(right);
  if (first === second) return 1;
  const parts = value => {
    const tokens = value.split(" ");
    const unit = tokens.findIndex(token => token === "ste" || token === "apt");
    return { number: tokens[0], street: tokens.slice(1, unit < 0 ? undefined : unit).join(" "),
      unit: unit < 0 ? "" : tokens.slice(unit).join(" ") };
  };
  const a = parts(first);
  const b = parts(second);
  if (!/^\d+[a-z]?(?:-\d+)?$/.test(a.number) || a.number !== b.number || a.unit !== b.unit) return 0;
  return similarity(a.street, b.street);
}

export function rankFacilities(place, facilities) {
  const name = normalize(place.name);
  const street = streetKey(place.address);
  const zip = place.address.match(/\b9\d{4}\b/)?.[0];
  const parts = place.address.split(",").map(part => part.trim());
  const stateIndex = parts.findIndex(part => /^(CA|California)\b/i.test(part));
  const city = stateIndex > 1 ? normalize(parts[stateIndex - 1]) : "";
  return facilities.map(facility => {
    const exactAddress = streetKey(facility.address) === street;
    const exactName = normalize(facility.name) === name;
    const zipConflict = Boolean(zip && facility.postalCode && zip !== facility.postalCode.slice(0, 5));
    const cityConflict = Boolean(city && facility.city && city !== normalize(facility.city));
    const nameScore = nameSimilarity(place.name, facility.name);
    const addressScore = addressSimilarity(place.address, facility.address);
    const similar = !zipConflict && !cityConflict && nameScore >= 0.75 && addressScore >= 0.85;
    const fuzzyMatch = !zipConflict && !cityConflict
      && ((exactAddress && nameScore >= 0.85) || (nameScore >= 0.93 && addressScore >= 0.9));
    return { ...facility, exactMatch: exactAddress && exactName && !zipConflict && !cityConflict,
      fuzzyMatch, nameScore, addressScore,
      rank: zipConflict ? -1 : exactAddress ? (exactName ? 4 : 2 + nameScore)
        : exactName ? 1 + addressScore / 2 : similar ? (nameScore + addressScore) / 2 : 0 };
  }).filter(item => item.rank > 0).sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

export function selectMatch(place, facilities) {
  const candidates = rankFacilities(place, facilities);
  const exact = candidates.filter(item => item.exactMatch);
  const similar = candidates.filter(item => item.fuzzyMatch);
  let chosen;
  let matchBasis;
  if (exact.length === 1) { [chosen] = exact; matchBasis = "exact"; }
  else if (!exact.length && similar.length === 1) { [chosen] = similar; matchBasis = "similar"; }
  else if (candidates.length === 1) { [chosen] = candidates; matchBasis = "single"; }
  const visible = chosen ? [chosen, ...candidates.filter(item => item !== chosen)] : candidates;
  return { match: chosen ? { ...chosen, matchBasis } : null, candidates: visible.slice(0, 10) };
}
