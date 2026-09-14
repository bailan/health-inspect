export class SourceAccessError extends Error {}

async function request(url, format, { fetchImpl = fetch, timeout = 20000, method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      method, body,
      headers: { Accept: format === "json" ? "application/json" : "text/html", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error instanceof SourceAccessError) throw error;
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new Error("The official data source timed out. Retry or use the county's website.", { cause: error });
    }
    throw new Error("Could not connect to the official data source. Check your connection or use the county's website.", { cause: error });
  }
  if (!response.ok) throw new Error(`The official data source returned HTTP ${response.status}. Retry or use the county's website.`);
  try {
    return await response[format]();
  } catch (error) {
    throw new Error("The official data source returned an unreadable response, not inspection records.", { cause: error });
  }
}

export function fetchJSON(url, options) {
  return request(url, "json", options);
}

export function fetchText(url, options) {
  return request(url, "text", options);
}

export function quoteSoQL(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function resourceURL(base, parameters) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  return url.href;
}
