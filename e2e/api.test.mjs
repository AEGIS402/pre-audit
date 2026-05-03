import { test } from "node:test";
import assert from "node:assert/strict";

import { loadSubmoduleAddresses, readSubmoduleFile } from "./submodule.mjs";

const BASE_URL = (process.env.E2E_BASE_URL || "http://127.0.0.1:13001").replace(/\/$/, "");
const SEPOLIA_CHAIN_ID = 11155111;
const TEST_TIMEOUT_MS = Number(process.env.E2E_TEST_TIMEOUT_MS || 180_000);

const ADDRESSES = loadSubmoduleAddresses();

async function apiFetch(path, init = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave json null; some routes may return non-JSON on error
  }
  return { res, text, json };
}

test("GET /health returns ok and reports upstream configured", { timeout: 10_000 }, async () => {
  const { res, json } = await apiFetch("/health");
  assert.equal(res.status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.upstream_configured, true);
});

test("POST /v1/contracts/analyze rejects empty body", { timeout: 10_000 }, async () => {
  const { res, json } = await apiFetch("/v1/contracts/analyze", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "",
  });
  assert.equal(res.status, 400);
  assert.equal(json.error, "empty_body");
});

test("POST /v1/contracts/analyze accepts raw Solidity from the submodule", { timeout: TEST_TIMEOUT_MS }, async () => {
  const source = readSubmoduleFile("contracts/Aegis402VulnerableHook.sol");
  const { res, json } = await apiFetch("/v1/contracts/analyze", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: source,
  });

  assert.equal(res.status, 200, `analyzer status=${res.status}`);
  assert.ok(json && typeof json === "object", "analyzer response should be JSON object");
  assert.ok(Array.isArray(json.vulnerabilities), "response.vulnerabilities should be an array");
});

test("POST /v1/tx/preflight rejects non-Sepolia chain", { timeout: 10_000 }, async () => {
  const { res, json } = await apiFetch("/v1/tx/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ADDRESSES.deployer, chainId: 1 }),
  });
  assert.equal(res.status, 400);
  assert.equal(json.error, "unsupported_chain");
});

test("POST /v1/tx/preflight rejects malformed address", { timeout: 10_000 }, async () => {
  const { res, json } = await apiFetch("/v1/tx/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "0xnothex", chainId: SEPOLIA_CHAIN_ID }),
  });
  assert.equal(res.status, 400);
  assert.equal(json.error, "invalid_address");
});

test("POST /v1/tx/preflight classifies the deployer EOA as safe", { timeout: 30_000 }, async () => {
  const { res, json } = await apiFetch("/v1/tx/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ADDRESSES.deployer, chainId: SEPOLIA_CHAIN_ID }),
  });
  assert.equal(res.status, 200);
  assert.equal(json.address_type, "eoa");
  assert.equal(json.code_status, "none");
  assert.equal(json.verdict, "safe");
  assert.equal(json.audit, null);
});

test("POST /v1/tx/preflight runs analyzer on verified Aegis402SafeHook", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { res, json } = await apiFetch("/v1/tx/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ADDRESSES.safeHook, chainId: SEPOLIA_CHAIN_ID }),
  });
  assert.equal(res.status, 200);
  assert.equal(json.address_type, "contract");
  assert.equal(json.code_status, "verified");
  assert.ok(["safe", "unsafe"].includes(json.verdict), `unexpected verdict ${json.verdict}`);
  assert.ok(json.audit && Array.isArray(json.audit.vulnerabilities), "expected audit payload");
});

test("POST /v1/tx/preflight rates Aegis402VulnerableHook as unsafe", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { res, json } = await apiFetch("/v1/tx/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: ADDRESSES.vulnerableHook, chainId: SEPOLIA_CHAIN_ID }),
  });
  assert.equal(res.status, 200);
  assert.equal(json.address_type, "contract");
  assert.equal(json.code_status, "verified");
  assert.equal(json.verdict, "unsafe", `expected unsafe, reason=${json.reason}`);
  const flagged = (json.audit?.vulnerabilities || []).filter((v) =>
    ["medium", "high", "critical"].includes(String(v?.severity || "").toLowerCase()),
  );
  assert.ok(flagged.length >= 1, "expected at least one medium+ finding");
});
