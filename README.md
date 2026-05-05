# Pre-Audit API

This API server accepts Solidity source code, forwards it to an external audit analyzer, and returns the audit report. It also exposes a transaction preflight guard that resolves a destination address (EOA / verified contract / unverified contract) and runs the analyzer on verified Sepolia contracts before a wallet broadcasts the transaction.

## Setup

```sh
cp .env.sample .env
npm start
```

Or run inside Docker:

```sh
cp .env.sample .env
npm run docker:build
npm run docker:run         # detached, port 13001
npm run docker:logs        # follow logs
npm run docker:stop        # stop and remove
```

The container reads `.env` via `--env-file` and overrides `HOST=0.0.0.0` so the service is reachable on the host.

Fill `.env` with the real values before starting:

| Key | Required for | Notes |
| --- | --- | --- |
| `AUDIT_ANALYZER_URL` | both endpoints | Upstream analyzer URL (intentionally not shown here) |
| `ETHERSCAN_API_KEY` | `/v1/tx/preflight` | Etherscan v2 multichain API key |
| `SEPOLIA_RPC_URL` | `/v1/tx/preflight` | Defaults to `https://1rpc.io/sepolia` |
| `ANALYZER_REQUEST_FORMAT` | optional | Defaults to `source_code`; set to `messages` only when the upstream analyzer accepts chat-style `messages` requests |
| `ANALYZER_RESPONSE_CACHE_ENABLED` | optional | Defaults to `true`; disables API-side analyzer response cache when set to `false`, `0`, `no`, or `off` |
| `ANALYZER_RESPONSE_CACHE_TTL_MS` | optional | Defaults to `0`; `0` means entries do not expire by TTL |
| `ANALYZER_RESPONSE_CACHE_MAX_ENTRIES` | optional | Defaults to `4096`; set to `0` to disable cache storage |
| `ANALYZER_RESPONSE_CACHE_DB_PATH` | optional | Defaults to `.cache/analyzer-response-cache.sqlite` locally; Docker defaults to `/data/pre-audit/analyzer-response-cache.sqlite` |
| `ANALYZER_RESPONSE_CACHE_NAMESPACE` | optional | Defaults to `v1`; bump this when changing analyzer prompt/model semantics to invalidate old entries |

`.env` is not committed to git. If `PORT` is already in use, change it to an available port.

Analyzer responses are cached in SQLite by the exact normalized upstream request, upstream URL, and cache namespace. The cache opens with `PRAGMA journal_mode=WAL` and Docker uses the `pre-audit-cache` named volume mounted at `/data` so entries survive container replacement. Only successful `2xx` analyzer responses are stored, and concurrent identical analyzer requests share one upstream call. By default entries do not expire by TTL; when the cache exceeds `ANALYZER_RESPONSE_CACHE_MAX_ENTRIES`, the least recently accessed entry is evicted first. Direct analyze responses include an `x-analyzer-cache` header (`miss`, `hit`, `deduped`, or `bypass`); `/health` reports cache counters under `analyzer_response_cache`.

When `ANALYZER_REQUEST_FORMAT=messages`, the API places stable audit instructions in the first `system` message and the variable Solidity source in the second `user` message. This keeps the LLM-facing chat-template prefix identical across requests so an upstream prefill/prefix cache can reuse its warmed KV blocks while the changing contract source remains in the suffix. The user message contains the caller-provided source unchanged, so Solidity evidence line numbers stay aligned with the input. The default `source_code` format remains available for analyzer schema compatibility.

## API

### `POST /v1/contracts/analyze`

JSON:

```sh
curl -X POST http://localhost:13001/v1/contracts/analyze \
  -H 'content-type: application/json' \
  --data-binary @samples/Vault.json
```

Raw Solidity:

```sh
curl -X POST http://localhost:13001/v1/contracts/analyze \
  -H 'content-type: text/plain' \
  --data-binary @samples/Vault.sol
```

Accepted JSON fields are `source_code`, `solidity`, or `code`. By default, the upstream request is normalized to:

```json
{
  "source_code": "<solidity source>"
}
```

When `ANALYZER_REQUEST_FORMAT=messages`, the upstream request is normalized to a chat-style prompt-cache-friendly shape:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "<stable Solidity audit instructions and JSON schema>"
    },
    {
      "role": "user",
      "content": "<solidity source>"
    }
  ]
}
```

### `POST /v1/tx/preflight`

Transaction-time guard. Given a destination address, resolves whether it is an EOA, a verified contract, or an unverified contract on Sepolia, then runs the analyzer on the verified source. Returns `safe` / `warning` / `unsafe`.

```sh
curl -X POST http://localhost:13001/v1/tx/preflight \
  -H 'content-type: application/json' \
  -d '{"to":"0xc4680Ab74eB4a4F7379016aa7b6044380Ae4C0C0","chainId":11155111}'
```

Decision flow:

1. JSON-RPC `eth_getCode(to)`. Empty code → `address_type=eoa`, `verdict=safe`.
2. Etherscan v2 `getsourcecode`. Empty `SourceCode` → `code_status=unverified`, `verdict=warning` (analyzer skipped).
3. Verified source is normalized (Standard JSON Input is unwrapped, application files are kept and `@openzeppelin/`, `@uniswap/`, `lib/`, `node_modules/`, `forge-std/` paths are dropped) and forwarded to the analyzer.
4. Verdict from `vulnerabilities[]`: any finding with `severity` of `medium`/`high`/`critical` → `unsafe`. Otherwise `safe`.

Only `chainId=11155111` (Sepolia) is supported.

Response shape:

```json
{
  "to": "0x...",
  "chainId": 11155111,
  "address_type": "eoa | contract",
  "code_status": "none | unverified | verified",
  "verdict": "safe | warning | unsafe",
  "reason": "...",
  "audit": null
}
```

### `GET /health`

Server liveness check.

## Actual Example

The following example was run against the local API server with `samples/Vault.sol`. The server forwards the source to the configured analyzer URL from `.env`; the upstream URL is intentionally not shown here.

Request:

```sh
curl -X POST http://127.0.0.1:13001/v1/contracts/analyze \
  -H 'content-type: text/plain' \
  --data-binary @samples/Vault.sol
```

Response:

```json
{
  "model": "gpt-oss-120b",
  "score_version": "risk-v1",
  "overall_risk_score": 72,
  "overall_severity": "medium",
  "overall_summary": "The contract contains critical reentrancy vulnerability in withdraw and flawed authorization checks using tx.origin for privileged functions, allowing potential unauthorized treasury changes and ether sweep.",
  "vulnerabilities": [
    {
      "id": "V-001",
      "title": "Reentrancy in withdraw",
      "severity": "high",
      "risk_score": 75,
      "confidence_score": 92,
      "impact_score": 95,
      "exploitability_score": 10,
      "summary": "The withdraw function sends Ether to the caller via a low-level call before updating the caller's balance, enabling a reentrancy attack that can drain all deposited funds.",
      "remediation": "Update the user's balance (and other state) before making the external call, or use a reentrancy guard (e.g., OpenZeppelin's nonReentrant). Follow the Checks-Effects-Interactions pattern.",
      "evidence": [
        {
          "line_start": 38,
          "line_end": 48,
          "description": "External call to msg.sender at line 42 occurs before balance is reduced at line 46, creating a reentrancy window."
        }
      ]
    },
    {
      "id": "V-002",
      "title": "Authorization bypass via tx.origin",
      "severity": "medium",
      "risk_score": 50,
      "confidence_score": 92,
      "impact_score": 10,
      "exploitability_score": 10,
      "summary": "Privileged functions changeTreasury and emergencySweep rely on tx.origin == owner for access control. A malicious contract can be called by the owner, making tx.origin the owner while msg.sender is the attacker's contract, allowing the attacker to invoke these functions indirectly.",
      "remediation": "Replace tx.origin checks with proper msg.sender ownership checks (e.g., require(msg.sender == owner)) and consider using Ownable pattern. Also restrict emergencySweep to onlyOwner.",
      "evidence": [
        {
          "line_start": 52,
          "line_end": 57,
          "description": "changeTreasury uses tx.origin for auth at line 53."
        },
        {
          "line_start": 59,
          "line_end": 64,
          "description": "emergencySweep also uses tx.origin at line 60."
        }
      ]
    }
  ]
}
```

## E2E Tests

End-to-end tests run **outside** the container against `http://127.0.0.1:13001` and use the `x402-hook` submodule for both Solidity inputs and verified Sepolia addresses.

```sh
git submodule update --init --recursive
npm run docker:build && npm run docker:run
npm run e2e
```

Coverage:

| Test | What it exercises |
| --- | --- |
| `GET /health` | container liveness + `upstream_configured` flag |
| `POST /v1/contracts/analyze` (empty body) | `400 empty_body` validation |
| `POST /v1/contracts/analyze` (raw Solidity from submodule) | analyzer round-trip on `x402-hook/contracts/Aegis402VulnerableHook.sol` |
| `POST /v1/tx/preflight` (chainId=1) | `400 unsupported_chain` |
| `POST /v1/tx/preflight` (malformed address) | `400 invalid_address` |
| `POST /v1/tx/preflight` (deployer EOA) | `address_type=eoa`, `verdict=safe` |
| `POST /v1/tx/preflight` (Aegis402SafeHook) | `code_status=verified`, analyzer ran |
| `POST /v1/tx/preflight` (Aegis402VulnerableHook) | `verdict=unsafe`, ≥1 medium+ finding |

Addresses are parsed from `x402-hook/README.md` at test time, so re-deploying the submodule and committing the new addresses is enough to point the suite at a fresh deployment. Override the target with `E2E_BASE_URL=http://host:port npm run e2e`.

## Sepolia Live Verification — `/v1/tx/preflight`

The `x402-hook` submodule deploys a paired safe and vulnerable Uniswap v4 hook to Sepolia (see [`x402-hook/README.md`](x402-hook/README.md)). Running the preflight against those addresses yields:

| Case | Address | `address_type` | `code_status` | `verdict` | Analyzer summary |
| --- | --- | --- | --- | --- | --- |
| Deployer EOA | `0x2f149CaA0e931e13f6F32bd3E46eFc6e96bcC36A` | `eoa` | `none` | `safe` | (analyzer skipped) |
| `Aegis402SafeHook` | `0xc4680Ab74eB4a4F7379016aa7b6044380Ae4C0C0` | `contract` | `verified` | `safe` | `overall_severity=info`, `overall_risk_score=0`, 0 findings |
| `Aegis402VulnerableHook` | `0x70fAA067bE47D8dc839088Dcfc6f9338c07c80C0` | `contract` | `verified` | `unsafe` | `overall_severity=critical`, `overall_risk_score=94`, 6 medium+ findings |

The 6 findings on `Aegis402VulnerableHook` map to the audit answer key in [`x402-hook/PROPOSAL.md`](x402-hook/PROPOSAL.md) §9:

| Answer key | Analyzer finding |
| --- | --- |
| V-01 missing access control | `[critical]` Missing access control on admin configuration functions |
| V-02 reentrancy-prone ordering | `[high]` Unchecked external call before settlement finalization (reentrancy risk) |
| V-03 unchecked arithmetic | `[medium]` Integer overflow/underflow in fee accounting |
| V-04 `tx.origin` authorization | `[high]` Authorization bypass using tx.origin |
| V-05 unchecked ERC20 transfer | `[medium]` Unchecked ERC20 transfer return value and premature settlement flag |
| (bonus) | `[high]` Missing payment validation and guard signature verification |
