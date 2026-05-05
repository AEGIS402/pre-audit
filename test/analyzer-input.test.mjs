import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANALYZER_PREFILL_PREFIX_VERSION,
  analyzerInputStats,
  prepareAnalyzerSourceCode,
} from "../src/analyzer-input.js";

test("prepareAnalyzerSourceCode adds a stable prefix before the variable source", () => {
  const source = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract A {}";
  const prepared = prepareAnalyzerSourceCode(source);

  assert.ok(prepared.startsWith("/* AEGIS402 analyzer prefill prefix v1."));
  assert.ok(prepared.endsWith(source));
  assert.equal(countNewlines(prepared), countNewlines(source));
  assert.equal(prepared.includes(`${ANALYZER_PREFILL_PREFIX_VERSION}\n`), false);
});

test("analyzerInputStats exposes prefix cache metadata without the prefix body", () => {
  const stats = analyzerInputStats();

  assert.equal(stats.prefill_prefix_enabled, true);
  assert.equal(stats.prefill_prefix_version, ANALYZER_PREFILL_PREFIX_VERSION);
  assert.ok(stats.prefill_prefix_chars > 100);
  assert.equal(Object.hasOwn(stats, "prefill_prefix"), false);
});

function countNewlines(value) {
  return (value.match(/\n/g) || []).length;
}
