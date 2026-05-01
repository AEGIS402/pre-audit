# Pre-Audit API

This API server accepts Solidity source code, forwards it to an external audit analyzer, and returns the audit report.

## Setup

```sh
cp .env.sample .env
npm start
```

Set the real analyzer endpoint in `AUDIT_ANALYZER_URL` inside `.env` before starting the server. `.env` is not committed to git. If `PORT` is already in use, change it to an available port.

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

Accepted JSON fields are `source_code`, `solidity`, or `code`. The upstream request is normalized to:

```json
{
  "source_code": "<solidity source>"
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
