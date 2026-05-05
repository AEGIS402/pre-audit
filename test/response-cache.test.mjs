import { test } from "node:test";
import assert from "node:assert/strict";

import { createAnalyzerCacheKey, createResponseCache } from "../src/response-cache.js";

test("createAnalyzerCacheKey is stable and includes namespace, upstream, and source", () => {
  const key = createAnalyzerCacheKey({
    namespace: "v1",
    upstreamUrl: "http://analyzer.local/analyze",
    sourceCode: "contract A {}",
  });

  assert.equal(
    key,
    createAnalyzerCacheKey({
      namespace: "v1",
      upstreamUrl: "http://analyzer.local/analyze",
      sourceCode: "contract A {}",
    }),
  );
  assert.notEqual(
    key,
    createAnalyzerCacheKey({
      namespace: "v2",
      upstreamUrl: "http://analyzer.local/analyze",
      sourceCode: "contract A {}",
    }),
  );
  assert.notEqual(
    key,
    createAnalyzerCacheKey({
      namespace: "v1",
      upstreamUrl: "http://analyzer.local/analyze",
      sourceCode: "contract B {}",
    }),
  );
});

test("response cache expires entries and trims least-recently-used values", () => {
  let now = 1_000;
  const cache = createResponseCache({
    enabled: true,
    ttlMs: 100,
    maxEntries: 2,
    now: () => now,
  });

  cache.set("a", { status: 200, contentType: "application/json", body: "a" });
  cache.set("b", { status: 200, contentType: "application/json", body: "b" });
  assert.equal(cache.get("a").body, "a");

  cache.set("c", { status: 200, contentType: "application/json", body: "c" });
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a").body, "a");

  now = 1_101;
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("c"), null);
});
