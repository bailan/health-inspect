/* Shared with the classic content script and Node's test runner. */
(() => {
  const foodCategories = new Set([
    "cafe", "cafeteria", "coffee shop", "coffee stand", "espresso bar",
    "bakery", "patisserie", "pastry shop", "bagel shop", "donut shop",
    "diner", "bistro", "brasserie", "bar and grill", "gastropub",
    "sandwich shop", "deli", "delicatessen", "pizza takeaway", "pizza delivery",
    "meal takeaway", "meal delivery", "food court", "food truck",
    "ice cream shop", "frozen yogurt shop", "dessert shop", "creperie",
    "juice shop", "bubble tea store", "tea house", "salad shop",
  ]);

  function normalize(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function isFoodCategory(category) {
    if (typeof category !== "string" || category.trim().length > 120) return false;
    const value = normalize(category.replace(/&/g, " and "));
    return /(?:^| )restaurant$/.test(value) || foodCategories.has(value);
  }

  function contextFromSnapshot({ url, name, address, category }) {
    if (!isFoodCategory(category)) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (!["www.google.com", "maps.google.com"].includes(parsed.hostname)) return null;
    const place = parsed.pathname.match(/\/maps\/place\/([^/]+)/);
    if (!place || !name?.trim() || !address?.trim()) return null;
    let urlName;
    try { urlName = decodeURIComponent(place[1].replace(/\+/g, " ")); } catch { return null; }
    // During SPA navigation, the URL can change before the old details disappear.
    if (normalize(urlName) !== normalize(name)) return null;
    const cleanAddress = address.replace(/^Address:\s*/i, "").trim();
    if (!/\d/.test(cleanAddress)) return null;
    return {
      name: name.trim().slice(0, 250),
      address: cleanAddress.slice(0, 500),
      category: category.trim(),
      key: `${normalize(name)}|${normalize(cleanAddress)}`,
    };
  }

  globalThis.HealthInspectMaps = { contextFromSnapshot, isFoodCategory };
})();
