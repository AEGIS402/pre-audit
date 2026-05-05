import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAnalyzerCacheKey, createResponseCache } from "../src/response-cache.js";

test("createAnalyzerCacheKey is stable and includes namespace, upstream, and source", () => {
  const key = createAnalyzerCacheKey({
    namespace: "v1",
    upstreamUrl: "http://analyzer.local/analyze",
    requestBody: { messages: [{ role: "user", content: "contract A {}" }] },
  });

  assert.equal(
    key,
    createAnalyzerCacheKey({
      namespace: "v1",
      upstreamUrl: "http://analyzer.local/analyze",
      requestBody: { messages: [{ role: "user", content: "contract A {}" }] },
    }),
  );
  assert.notEqual(
    key,
    createAnalyzerCacheKey({
      namespace: "v2",
      upstreamUrl: "http://analyzer.local/analyze",
      requestBody: { messages: [{ role: "user", content: "contract A {}" }] },
    }),
  );
  assert.notEqual(
    key,
    createAnalyzerCacheKey({
      namespace: "v1",
      upstreamUrl: "http://analyzer.local/analyze",
      requestBody: { messages: [{ role: "user", content: "contract B {}" }] },
    }),
  );
});

test("response cache expires entries and trims least-recently-used values", () => {
  let now = 1_000;
  const cache = createResponseCache({
    enabled: true,
    ttlMs: 100,
    maxEntries: 2,
    dbPath: testDbPath(),
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
  const dbPath = testDbPath();
  const cache = createResponseCache({ dbPath, now: () => now });

  assert.deepEqual(cache.stats(), {
    enabled: true,
    storage: "sqlite",
    db_path: dbPath,
    journal_mode: "wal",
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
    dbPath: testDbPath(),
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

test("response cache persists entries in sqlite across instances", () => {
  const dbPath = testDbPath();
  const first = createResponseCache({ dbPath });
  first.set("a", { status: 200, contentType: "application/json", body: "a" });

  const second = createResponseCache({ dbPath });

  assert.equal(second.get("a").body, "a");
  assert.equal(second.stats().journal_mode, "wal");
});

function testDbPath() {
  return join(mkdtempSync(join(tmpdir(), "pre-audit-cache-test-")), "cache.sqlite");
}
