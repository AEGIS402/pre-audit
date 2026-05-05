import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANALYZER_SYSTEM_PROMPT_VERSION,
  analyzerInputStats,
  buildAnalyzerRequest,
} from "../src/analyzer-input.js";

test("buildAnalyzerRequest defaults to source_code for analyzer compatibility", () => {
  assert.deepEqual(buildAnalyzerRequest("contract A {}"), {
    source_code: "contract A {}",
  });
});

test("buildAnalyzerRequest can keep fixed context in system and variable source in user", () => {
  const source = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract A {}";
  const request = buildAnalyzerRequest(source, { requestFormat: "messages" });

  assert.deepEqual(
    request.messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.ok(request.messages[0].content.includes("smart-contract pre-audit assistant"));
  assert.ok(request.messages[0].content.length > 1_000);
  assert.equal(request.messages[1].content, source);
  assert.equal(countNewlines(request.messages[1].content), countNewlines(source));
});

test("analyzerInputStats exposes messages prompt-cache metadata without the prompt body", () => {
  const stats = analyzerInputStats("messages");

  assert.equal(stats.analyzer_request_format, "messages");
  assert.equal(stats.prompt_cache_format, "messages");
  assert.equal(stats.system_prompt_version, ANALYZER_SYSTEM_PROMPT_VERSION);
  assert.ok(stats.system_prompt_chars > 1_000);
  assert.equal(Object.hasOwn(stats, "system_prompt"), false);
});

test("analyzerInputStats reports source_code mode when messages are disabled", () => {
  const stats = analyzerInputStats("source_code");

  assert.equal(stats.analyzer_request_format, "source_code");
  assert.equal(stats.prompt_cache_format, "source_code");
  assert.equal(stats.system_prompt_chars, 0);
});

function countNewlines(value) {
  return (value.match(/\n/g) || []).length;
}
