import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createAnalyzerClient } from "../src/analyzer-client.js";
import { buildAnalyzerRequest } from "../src/analyzer-input.js";

test("createAnalyzerClient caches successful analyzer responses by source", async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(init.body), { source_code: "contract A {}" });
    return jsonResponse({ calls });
  };

  const client = createAnalyzerClient({
    upstreamUrl: "http://analyzer.local/analyze",
    requestTimeoutMs: 1_000,
    cacheOptions: testCacheOptions(),
    cacheNamespace: "test",
    fetchImpl,
  });

  const first = await client.callAnalyzer("contract A {}");
  const second = await client.callAnalyzer("contract A {}");

  assert.equal(calls, 1);
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "hit");
  assert.deepEqual(JSON.parse(second.body), { calls: 1 });
  assert.equal(client.cacheStats().hits, 1);
});

test("createAnalyzerClient can send prompt-cache-friendly messages requests", async () => {
  const fetchImpl = async (_url, init) => {
    assert.deepEqual(
      JSON.parse(init.body),
      buildAnalyzerRequest("contract A {}", { requestFormat: "messages" }),
    );
    return jsonResponse({ ok: true });
  };

  const client = createAnalyzerClient({
    upstreamUrl: "http://analyzer.local/analyze",
    requestTimeoutMs: 1_000,
    requestFormat: "messages",
    cacheOptions: testCacheOptions(),
    cacheNamespace: "test",
    fetchImpl,
  });

  const result = await client.callAnalyzer("contract A {}");

  assert.equal(result.status, 200);
  assert.equal(client.cacheStats().analyzer_request_format, "messages");
});

test("createAnalyzerClient does not cache analyzer errors", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({ error: "temporary" }, { status: 500 });
  };

  const client = createAnalyzerClient({
    upstreamUrl: "http://analyzer.local/analyze",
    requestTimeoutMs: 1_000,
    cacheOptions: testCacheOptions(),
    cacheNamespace: "test",
    fetchImpl,
  });

  const first = await client.callAnalyzer("contract A {}");
  const second = await client.callAnalyzer("contract A {}");

  assert.equal(calls, 2);
  assert.equal(first.status, 500);
  assert.equal(second.status, 500);
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "miss");
});

test("createAnalyzerClient deduplicates concurrent requests for the same source", async () => {
  let calls = 0;
  let resolveFetch;
  const fetchImpl = async () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveFetch = () => resolve(jsonResponse({ ok: true }));
    });
  };

  const client = createAnalyzerClient({
    upstreamUrl: "http://analyzer.local/analyze",
    requestTimeoutMs: 1_000,
    cacheOptions: testCacheOptions(),
    cacheNamespace: "test",
    fetchImpl,
  });

  const firstPromise = client.callAnalyzer("contract A {}");
  const secondPromise = client.callAnalyzer("contract A {}");
  resolveFetch();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls, 1);
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "deduped");
  assert.deepEqual(JSON.parse(second.body), { ok: true });
});

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function testCacheOptions() {
  return {
    enabled: true,
    ttlMs: 60_000,
    maxEntries: 10,
    dbPath: join(mkdtempSync(join(tmpdir(), "pre-audit-analyzer-test-")), "cache.sqlite"),
  };
}
