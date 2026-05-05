export const ANALYZER_PREFILL_PREFIX_VERSION = "prefill-prefix-v1";

const ANALYZER_PREFILL_PREFIX =
  "/* AEGIS402 analyzer prefill prefix v1. This stable prefix is intentionally placed before every variable Solidity suffix so local LLM prefix caching can reuse KV blocks across audit requests. Treat this comment as cache-warming metadata, not auditable contract logic. Analyze only the Solidity source that follows this comment. Use the service's normal JSON schema and severity rubric. Focus on exploitable smart-contract security issues including access control, authorization, tx.origin misuse, signature validation, replay protection, payment validation, reentrancy, checks-effects-interactions violations, unchecked external calls, unchecked ERC20 return values, arithmetic and accounting errors, oracle or price manipulation, slippage and settlement validation, delegatecall and storage collision risks, initialization and upgradeability mistakes, denial of service, frontrunning or MEV assumptions, unsafe low-level calls, invariant violations, and missing validation around privileged configuration. Prefer concrete evidence from the following source over generic best-practice findings. */";

export function prepareAnalyzerSourceCode(sourceCode) {
  return `${ANALYZER_PREFILL_PREFIX}${sourceCode}`;
}

export function analyzerInputStats() {
  return {
    prefill_prefix_enabled: true,
    prefill_prefix_version: ANALYZER_PREFILL_PREFIX_VERSION,
    prefill_prefix_chars: ANALYZER_PREFILL_PREFIX.length,
  };
}
