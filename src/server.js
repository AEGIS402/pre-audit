import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";

loadEnv();

const PORT = parseInteger(process.env.PORT, 13001);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_URL = process.env.AUDIT_ANALYZER_URL;
const REQUEST_TIMEOUT_MS = parseInteger(process.env.REQUEST_TIMEOUT_MS, 600_000);
const MAX_BODY_BYTES = parseInteger(process.env.MAX_BODY_BYTES, 5 * 1024 * 1024);

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendJson(res, status, {
      error: status === 500 ? "internal_server_error" : error.code || "request_error",
      message: status === 500 ? "Unexpected server error" : error.message,
    });
  }
});

server.timeout = REQUEST_TIMEOUT_MS + 30_000;

server.listen(PORT, HOST, () => {
  console.log(`pre-audit-api listening on http://${HOST}:${PORT}`);
});

async function route(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      upstream_configured: Boolean(UPSTREAM_URL),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/contracts/analyze") {
    await analyzeContract(req, res);
    return;
  }

  sendJson(res, 404, {
    error: "not_found",
    message: "Route not found",
  });
}

async function analyzeContract(req, res) {
  if (!UPSTREAM_URL) {
    sendJson(res, 500, {
      error: "missing_upstream_url",
      message: "AUDIT_ANALYZER_URL is not configured",
    });
    return;
  }

  const sourceCode = await readSourceCode(req);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(UPSTREAM_URL, {
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

    res.writeHead(upstreamResponse.status, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    res.end(responseBody);
  } catch (error) {
    if (error.name === "AbortError") {
      sendJson(res, 504, {
        error: "upstream_timeout",
        message: `Audit analyzer did not respond within ${REQUEST_TIMEOUT_MS}ms`,
      });
      return;
    }

    sendJson(res, 502, {
      error: "upstream_request_failed",
      message: error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readSourceCode(req) {
  const body = await readRequestBody(req);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();

  if (!body.length) {
    throw httpError(400, "empty_body", "Request body is required");
  }

  if (contentType.includes("application/json")) {
    let payload;

    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw httpError(400, "invalid_json", "Request body must be valid JSON");
    }

    const sourceCode = payload?.source_code ?? payload?.solidity ?? payload?.code;
    return validateSourceCode(sourceCode);
  }

  return validateSourceCode(body.toString("utf8"));
}

function validateSourceCode(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, "invalid_source_code", "Solidity source code must be a non-empty string");
  }

  return value;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }

      bytes += chunk.length;

      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(httpError(413, "payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!tooLarge) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (error) => {
      if (!tooLarge) {
        reject(error);
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function loadEnv(fileName = ".env") {
  const envPath = join(process.cwd(), fileName);
  let contents;

  try {
    contents = readFileSync(envPath, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripQuotes(rawValue);
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
