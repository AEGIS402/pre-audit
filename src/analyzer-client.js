import { createAnalyzerCacheKey, createResponseCache } from "./response-cache.js";

export function createAnalyzerClient({
  upstreamUrl,
  requestTimeoutMs = 600_000,
  cacheOptions,
  cacheNamespace = "v1",
  fetchImpl = fetch,
  createError = defaultCreateError,
} = {}) {
  const cache = createResponseCache(cacheOptions);
  const pending = new Map();

  async function callAnalyzer(sourceCode) {
    if (!upstreamUrl) {
      throw createError(503, "missing_upstream_url", "AUDIT_ANALYZER_URL is not configured");
    }

    const cacheKey = cache.enabled
      ? createAnalyzerCacheKey({ sourceCode, upstreamUrl, namespace: cacheNamespace })
      : null;

    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return { ...cached, cacheStatus: "hit" };
      }

      const pendingRequest = pending.get(cacheKey);
      if (pendingRequest) {
        const result = await pendingRequest;
        return { ...result, cacheStatus: "deduped" };
      }
    }

    const requestPromise = fetchAnalyzer({
      sourceCode,
      upstreamUrl,
      requestTimeoutMs,
      fetchImpl,
      createError,
    }).then((result) => {
      if (cacheKey && isCacheableAnalyzerResponse(result)) {
        cache.set(cacheKey, result);
      }
      return result;
    });

    if (cacheKey) {
      pending.set(cacheKey, requestPromise);
    }

    try {
      const result = await requestPromise;
      return { ...result, cacheStatus: cacheKey ? "miss" : "bypass" };
    } finally {
      if (cacheKey) {
        pending.delete(cacheKey);
      }
    }
  }

  function cacheStats() {
    return {
      ...cache.stats(),
      pending: pending.size,
      namespace: cacheNamespace,
    };
  }

  return { callAnalyzer, cacheStats };
}

export function isCacheableAnalyzerResponse(result) {
  return result.status >= 200 && result.status < 300;
}

async function fetchAnalyzer({
  sourceCode,
  upstreamUrl,
  requestTimeoutMs,
  fetchImpl,
  createError,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const upstreamResponse = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ source_code: sourceCode }),
      signal: controller.signal,
    });

    const responseBody = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type") || "application/json";

    return { status: upstreamResponse.status, contentType, body: responseBody };
  } catch (error) {
    if (error.name === "AbortError") {
      throw createError(504, "upstream_timeout", `Audit analyzer did not respond within ${requestTimeoutMs}ms`);
    }

    throw createError(502, "upstream_request_failed", error.message);
  } finally {
    clearTimeout(timeout);
  }
}

function defaultCreateError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
