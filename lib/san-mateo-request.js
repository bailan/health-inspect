(() => {
  const origin = "https://smcehs.my.site.com";
  const searchPath = "/s/inspection-report-search";
  const fields = {
    getBlaRecordList: ["fN", "fS", "fC", "bN", "vR"],
    getInspectionRecordList: ["blaId"],
    getViolationRecordList: ["visitRecId"],
    getFieldReadingRecordList: ["visitRecId"],
  };

  function validate(request) {
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password || url.hash) throw new Error("Unsupported San Mateo request URL.");
    if (request.method === "GET" && url.pathname === searchPath && !request.body) {
      if ([...url.searchParams].some(([key, value]) => key !== "language" || value !== "en_US")) throw new Error("Unsupported San Mateo search-page parameters.");
      return { url: url.href, method: "GET" };
    }
    if (request.method !== "POST" || url.pathname !== "/s/sfsites/aura" || typeof request.body !== "string" || request.body.length > 50000) {
      throw new Error("Only public San Mateo search and inspection reads are supported.");
    }
    if ([...url.searchParams].some(([key, value]) => !["r", "aura.ApexAction.execute"].includes(key) || value !== "1")) {
      throw new Error("Unsupported San Mateo action URL.");
    }
    const form = new URLSearchParams(request.body);
    const allowed = ["message", "aura.context", "aura.pageURI", "aura.token"];
    if ([...form.keys()].some(key => !allowed.includes(key)) || allowed.some(key => form.getAll(key).length !== 1)
      || form.get("aura.token") !== "null" || form.get("aura.pageURI") !== `${searchPath}?language=en_US`) {
      throw new Error("San Mateo requests must use the anonymous public search context.");
    }
    const { actions } = JSON.parse(form.get("message"));
    if (!Array.isArray(actions) || !actions.length || actions.length > 6) throw new Error("Invalid San Mateo read-action batch.");
    for (const action of actions) {
      const params = action?.params;
      const keys = params && Object.hasOwn(fields, params.method) ? fields[params.method] : null;
      if (action?.descriptor !== "aura://ApexActionController/ACTION$execute"
        || action.callingDescriptor !== "UNKNOWN" || params?.classname !== "smcehs_InspectionReportSearchHandler"
        || params.namespace !== "" || params.cacheable !== false || params.isContinuation !== false || !keys
        || !params.params || Object.keys(params.params).length !== keys.length
        || keys.some(key => typeof params.params[key] !== "string" || params.params[key].length > 500)
        || !keys.some(key => params.params[key].trim())) {
        throw new Error("Only the county's verified, read-only inspection actions are permitted.");
      }
    }
    return { url: url.href, method: "POST", body: form.toString() };
  }

  globalThis.HealthInspectSanMateoRequest = Object.freeze({ validate });
})();
