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
  now = 1_001;
  assert.equal(cache.get("a").body, "a");

  now = 1_002;
  cache.set("c", { status: 200, contentType: "application/json", body: "c" });
  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a").body, "a");

  now = 1_103;
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("c"), null);
});

test("response cache defaults to no TTL expiration and 4096 max entries", () => {
  let now = 1_000;
  const cache = createResponseCache({ now: () => now });

  assert.deepEqual(cache.stats(), {
    enabled: true,
    ttl_ms: 0,
    max_entries: 4096,
    size: 0,
    hits: 0,
    misses: 0,
    sets: 0,
    evictions: 0,
  });

  cache.set("a", { status: 200, contentType: "application/json", body: "a" });
  now = 9_999_999;

  assert.equal(cache.get("a").body, "a");
});

test("response cache evicts the oldest accessed entry when max entries is exceeded", () => {
  let now = 1_000;
  const cache = createResponseCache({
    ttlMs: 0,
    maxEntries: 2,
    now: () => now,
  });

  cache.set("a", { status: 200, contentType: "application/json", body: "a" });
  now = 1_001;
  cache.set("b", { status: 200, contentType: "application/json", body: "b" });
  now = 1_002;
  assert.equal(cache.get("a").body, "a");

  now = 1_003;
  cache.set("c", { status: 200, contentType: "application/json", body: "c" });

  assert.equal(cache.get("b"), null);
  assert.equal(cache.get("a").body, "a");
  assert.equal(cache.get("c").body, "c");
});
