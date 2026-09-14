import { normalize } from "./matching.js";

const cities = {
  sf: ["San Francisco", "San Francisco County"],
  sm: [
    "Atherton", "Belmont", "Brisbane", "Burlingame", "Colma", "Daly City", "East Palo Alto",
    "Foster City", "Half Moon Bay", "Hillsborough", "Menlo Park", "Millbrae", "Pacifica",
    "Portola Valley", "Redwood City", "San Bruno", "San Carlos", "San Mateo",
    "South San Francisco", "Woodside", "El Granada", "Montara", "Moss Beach",
    "Pescadero", "La Honda", "Broadmoor", "North Fair Oaks", "Emerald Hills",
    "Ladera", "West Menlo Park", "San Mateo County",
  ],
  sc: [
    "Campbell", "Cupertino", "Gilroy", "Los Altos", "Los Altos Hills", "Los Gatos",
    "Milpitas", "Monte Sereno", "Morgan Hill", "Mountain View", "Palo Alto",
    "San Jose", "Santa Clara", "Saratoga", "Sunnyvale", "Stanford", "San Martin",
    "Alum Rock", "Burbank", "Cambrian Park", "Fruitdale", "Loyola", "East Foothills",
    "Santa Clara County",
  ],
};

export function inferCounty(address) {
  const parts = address.replace(/\r?\n/g, ",").split(",").map(part => part.trim()).filter(Boolean);
  for (let index = 1; index < parts.length; index++) {
    const state = parts[index].match(/^(CA|California)(?:\s+\d{5}(?:-\d{4})?)?$/i);
    const combined = parts[index].match(/^(.+?)\s+(?:CA|California)(?:\s+\d{5}(?:-\d{4})?)?$/i);
    const locality = state && index > 1 ? parts[index - 1] : combined?.[1];
    if (!locality) continue;
    for (const [county, names] of Object.entries(cities)) {
      if (names.some(name => normalize(locality) === normalize(name))) return county;
    }
    return null;
  }
  return null;
}
