const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";
const SUPPORTED_CHAIN_ID = 11155111;
const DEFAULT_SEPOLIA_RPC = "https://1rpc.io/sepolia";

export async function runPreflight({ body, callAnalyzer, env }) {
  const { to, chainId } = parseRequest(body);

  if (chainId !== SUPPORTED_CHAIN_ID) {
    throw httpError(
      400,
      "unsupported_chain",
      `chainId ${chainId} is not supported (only ${SUPPORTED_CHAIN_ID})`,
    );
  }

  const rpcUrl = env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC;
  const code = await getCode(rpcUrl, to);

  if (code === "0x" || code === "") {
    return baseResult(to, chainId, {
      address_type: "eoa",
      code_status: "none",
      verdict: "safe",
      reason: "EOA",
      audit: null,
    });
  }

  const apiKey = env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    throw httpError(503, "missing_etherscan_key", "ETHERSCAN_API_KEY is not configured");
  }

  const sourceResult = await getEtherscanSource(chainId, to, apiKey);
  const sourceCodeRaw = typeof sourceResult?.SourceCode === "string" ? sourceResult.SourceCode : "";

  if (!sourceCodeRaw.trim()) {
    return baseResult(to, chainId, {
      address_type: "contract",
      code_status: "unverified",
      verdict: "warning",
      reason: "contract source not verified on Etherscan",
      audit: null,
    });
  }

  const sourceCode = normalizeEtherscanSource(sourceCodeRaw);
  const analyzerRes = await callAnalyzer(sourceCode);

  let audit = null;
  try {
    audit = JSON.parse(analyzerRes.body);
  } catch {
    return baseResult(to, chainId, {
      address_type: "contract",
      code_status: "verified",
      verdict: "unsafe",
      reason: "analyzer response malformed",
      audit: null,
    });
  }

  if (analyzerRes.status >= 400) {
    return baseResult(to, chainId, {
      address_type: "contract",
      code_status: "verified",
      verdict: "unsafe",
      reason: `analyzer returned status ${analyzerRes.status}`,
      audit,
    });
  }

  const vulnerabilities = Array.isArray(audit?.vulnerabilities) ? audit.vulnerabilities : null;
  if (!vulnerabilities) {
    return baseResult(to, chainId, {
      address_type: "contract",
      code_status: "verified",
      verdict: "unsafe",
      reason: "analyzer response malformed",
      audit,
    });
  }

  const flagged = vulnerabilities.filter((entry) => {
    const severity = String(entry?.severity || "").toLowerCase();
    return severity === "medium" || severity === "high" || severity === "critical";
  });

  if (flagged.length === 0) {
    return baseResult(to, chainId, {
      address_type: "contract",
      code_status: "verified",
      verdict: "safe",
      reason: "no medium+ findings",
      audit,
    });
  }

  return baseResult(to, chainId, {
    address_type: "contract",
    code_status: "verified",
    verdict: "unsafe",
    reason: `found ${flagged.length} medium+ finding${flagged.length === 1 ? "" : "s"}`,
    audit,
  });
}

function baseResult(to, chainId, rest) {
  return { to, chainId, ...rest };
}

function parseRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "invalid_request", "Request body must be a JSON object");
  }

  const to = body.to;
  const chainId = body.chainId;

  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw httpError(400, "invalid_address", "Field 'to' must be a 0x-prefixed 20-byte address");
  }

  if (!Number.isInteger(chainId)) {
    throw httpError(400, "invalid_chain_id", "Field 'chainId' must be an integer");
  }

  return { to, chainId };
}

async function getCode(rpcUrl, address) {
  let response;

  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
    });
  } catch (error) {
    throw httpError(502, "rpc_failed", `RPC request failed: ${error.message}`);
  }

  if (!response.ok) {
    throw httpError(502, "rpc_failed", `RPC returned status ${response.status}`);
  }

  const json = await response.json().catch(() => null);
  if (!json || json.error) {
    throw httpError(502, "rpc_failed", json?.error?.message || "RPC response malformed");
  }

  return typeof json.result === "string" ? json.result : "";
}

async function getEtherscanSource(chainId, address, apiKey) {
  const url = new URL(ETHERSCAN_BASE);
  url.searchParams.set("chainid", String(chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", apiKey);

  let response;

  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw httpError(502, "etherscan_failed", `Etherscan request failed: ${error.message}`);
  }

  if (!response.ok) {
    throw httpError(502, "etherscan_failed", `Etherscan returned status ${response.status}`);
  }

  const json = await response.json().catch(() => null);
  if (!json) {
    throw httpError(502, "etherscan_failed", "Etherscan response malformed");
  }

  if (!Array.isArray(json.result)) {
    const message = typeof json.result === "string" ? json.result : json.message || "Etherscan response malformed";
    throw httpError(502, "etherscan_failed", message);
  }

  if (json.result.length === 0) {
    throw httpError(502, "etherscan_failed", "Etherscan response missing result array");
  }

  return json.result[0];
}

export function normalizeEtherscanSource(sourceCode) {
  const trimmed = sourceCode.trim();

  if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
    const inner = trimmed.slice(1, -1);
    const parsed = safeJsonParse(inner);
    if (parsed && parsed.sources && typeof parsed.sources === "object") {
      return concatSources(parsed.sources);
    }
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const parsed = safeJsonParse(trimmed);
    if (parsed && typeof parsed === "object") {
      if (parsed.sources && typeof parsed.sources === "object") {
        return concatSources(parsed.sources);
      }
      const entries = Object.values(parsed);
      if (entries.length > 0 && entries.every((entry) => entry && typeof entry === "object" && typeof entry.content === "string")) {
        return concatSources(parsed);
      }
    }
  }

  return sourceCode;
}

function concatSources(sources) {
  const appSources = filterAppSources(sources);
  const chosen = Object.keys(appSources).length > 0 ? appSources : sources;
  const parts = [];
  for (const [path, entry] of Object.entries(chosen)) {
    const content = entry?.content;
    if (typeof content === "string") {
      parts.push(`// ===== ${path} =====`);
      parts.push(content);
    }
  }
  return parts.join("\n");
}

function filterAppSources(sources) {
  const filtered = {};
  for (const [path, entry] of Object.entries(sources)) {
    if (isLibraryPath(path)) continue;
    filtered[path] = entry;
  }
  return filtered;
}

function isLibraryPath(path) {
  return (
    path.startsWith("@") ||
    path.includes("/node_modules/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("lib/") ||
    path.startsWith("forge-std/")
  );
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
