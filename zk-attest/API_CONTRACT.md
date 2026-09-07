# ZK-Attest API contract

This is the interface document for building a frontend against this
backend. Every request/response example below is real output from an
actual call made against a locally running server on this machine — none
of it is invented. If you never open `server/index.js`, this document
should still be enough to build against.

The backend does not serve or expect a frontend of its own beyond a static
`web/` directory (currently empty/placeholder — a separate frontend project
can point at this API directly instead). All endpoints are JSON in, JSON
out, no auth, no sessions, no cookies.

## Running the server

```
cd zk-attest
npm install
bash scripts/setup.sh   # one-time: compiles the circuit + runs a local trusted setup
node server/index.js
```

- **Port**: `3000` by default, override with the `PORT` env var (e.g. `PORT=4000 node server/index.js`). No other env vars are read.
- **First-run cost**: `scripts/setup.sh` downloads a `circom` v2.1.9 binary (falls back to a `cargo build` from source if no prebuilt binary exists for your platform), then runs a local Powers-of-Tau ceremony at 2^14. On this machine, a clean run took **1m47s**. It is idempotent — a second run detects existing artifacts and finishes in a couple of seconds. If you edit `circuits/settlement.circom` yourself, the script now detects that automatically (it hashes the circuit source and compares against the hash from the last build) and regenerates only what's actually stale — confirmed by real test: an edited circuit produced a genuinely different `settlement_final.zkey` (different SHA-256) on the next run, in 17.6s (ptau reused, only the zkey step re-ran), and reverting the edit correctly rebuilt the original zkey again. Same detection applies if `POT_POWER` itself changes.
- **Startup failure**: if `node server/index.js` exits immediately with a "Missing .../settlement.wasm" (or `.zkey`/verification key) error, `scripts/setup.sh` hasn't been run yet.
- **CORS**: open to all origins — call this API from a dev server on any port with no configuration on your end.

## Data model

An **institution** (as returned by the Treasury view):
```
{ "accountId": 1001, "balance": 12500000, "blocked": 0, "name": "Meridian Capital Partners", "role": "our client — clears the $1M bar comfortably" }
```
`blocked` is `0` or `1` — the custodian's own record of whether this account is flagged. `role` is demo narration only.

---

## `GET /api/book/treasury`

The custodian's full view: every institution, its real balance, its
blocked flag, plus the public commitment (Merkle root, custodian public
key, circuit stats). This is what the "Treasury" side of a two-pane UI
should render — it is allowed to know everything.

**Request**: no body.

**Response** `200`, real example:
```json
{
  "institutions": [
    { "accountId": 1001, "balance": 12500000, "blocked": 0, "name": "Meridian Capital Partners", "role": "our client — clears the $1M bar comfortably" },
    { "accountId": 1002, "balance": 4300000, "blocked": 0, "name": "Northfield Treasury Group", "role": "another honest institution" },
    { "accountId": 1003, "balance": 250000, "blocked": 0, "name": "Ashcombe Reserve Fund", "role": "below threshold — the tamper case" },
    { "accountId": 1004, "balance": 88000000, "blocked": 0, "name": "Corvatta Institutional Holdings", "role": "large institution, widens the anonymity set" },
    { "accountId": 1005, "balance": 9800000, "blocked": 1, "name": "Halcyon Trade Corp", "role": "sanctioned — clears the balance bar but is custodian-flagged blocked" }
  ],
  "merkleRoot": "5926933136962150110037142965096040245700348465956023869488266929899111796712",
  "treeDepth": 8,
  "custodianPubKey": {
    "Ax": "5865220112433696882887055243045610474363543799613121988013131740146980953685",
    "Ay": "9709176769543063684874449670475569717231731735851790820511725120062754544518"
  },
  "circuitStats": {
    "nonLinearConstraints": 6510,
    "linearConstraints": 0,
    "privateInputs": 23,
    "publicInputs": 5,
    "source": "parsed from the circom compiler's own stdout at setup time",
    "generatedAt": "2026-09-07T12:08:18Z"
  }
}
```

**Errors**: `500` on an unexpected internal failure (e.g. build artifacts missing at runtime after the boot-time check somehow passed then failed later — should not happen in normal operation).

```
curl http://localhost:3000/api/book/treasury
```

---

## `GET /api/book/exchange`

The Exchange side's view — deliberately minimal. No institution names, no
balances, no blocked flags. Only the public commitment: what the Exchange
is allowed to know *before* any proof arrives.

**Request**: no body.

**Response** `200`, real example:
```json
{
  "merkleRoot": "5926933136962150110037142965096040245700348465956023869488266929899111796712",
  "treeDepth": 8,
  "custodianPubKey": {
    "Ax": "5865220112433696882887055243045610474363543799613121988013131740146980953685",
    "Ay": "9709176769543063684874449670475569717231731735851790820511725120062754544518"
  },
  "circuitStats": {
    "nonLinearConstraints": 6510,
    "linearConstraints": 0,
    "privateInputs": 23,
    "publicInputs": 5,
    "source": "parsed from the circom compiler's own stdout at setup time",
    "generatedAt": "2026-09-07T12:08:18Z"
  }
}
```

**Errors**: `500` (same as above).

```
curl http://localhost:3000/api/book/exchange
```

Note there is deliberately **no plain `GET /api/book`** — that endpoint
used to return the entire institution list unauthenticated to either
party, and was removed as part of this API's Phase 2 fix. Requesting it
now 404s.

---

## `POST /api/prove`

Generates a real Groth16 proof for the given account, threshold, and trade
ID. No PII in the response — `accountId`, `balance`, `blocked`, the
signature, and all Merkle path data are private witness inputs and never
appear in what's returned.

**Request body**:
```json
{ "accountId": 1001, "threshold": 1000000, "tradeId": 42 }
```
All three fields are required and must be numbers.

**Response** `200`, real example (account 1001, threshold 1,000,000, tradeId 42):
```json
{
  "proof": {
    "pi_a": ["20519193832552837076910387193129340069430210889789736246756018713791722351318", "18481192280303260247792755037488504679553965180920037022982438373116209923731", "1"],
    "pi_b": [["3830160066870887045210914454824553110381013694637222772104420650552461796193", "12510942005406602780703842017679251269531672173394740329378923774591183778566"], ["6906904846589108315770469258062048498168958313248854293314399387265212659060", "12410850296825321863650124293846860210501707653181157792956949038399173154088"], ["1", "0"]],
    "pi_c": ["3956660411868505961685022248800426545650164963156543039496729896920356503899", "19632033734973301875196732488257691879069485314473098520694351991552383601464", "1"],
    "protocol": "groth16",
    "curve": "bn128"
  },
  "publicSignals": [
    "5926933136962150110037142965096040245700348465956023869488266929899111796712",
    "1000000",
    "42",
    "5865220112433696882887055243045610474363543799613121988013131740146980953685",
    "9709176769543063684874449670475569717231731735851790820511725120062754544518"
  ],
  "proveMs": 696,
  "constraintCount": 6510,
  "proofBytes": 724
}
```
`publicSignals` is always exactly `[merkleRoot, threshold, tradeId, custodianPubKeyAx, custodianPubKeyAy]`, in that order — fixed by the circuit's own `component main {public [...]}` declaration, not a convention this server invented.

**Errors**:
- `400` — missing/non-numeric fields, or an unknown account:
  ```json
  { "error": "accountId, threshold and tradeId are required." }
  ```
  ```json
  { "error": "No account 9999 in the custodian's book." }
  ```
- `422` — the witness itself cannot be constructed (this is an expected outcome of a bad claim, not a server error). Body always includes `failedAt`, one of `"merkleRoot"`, `"threshold"`, `"blocked"`, `"attestation"`:
  ```json
  { "error": "The account is genuinely in the custodian's tree, but its committed balance does not exceed the threshold. The proof cannot be constructed.", "failedAt": "threshold" }
  ```

```
curl -X POST http://localhost:3000/api/prove \
  -H 'content-type: application/json' \
  -d '{"accountId":1001,"threshold":1000000,"tradeId":42}'
```

---

## `POST /api/verify`

Calls the real `snarkjs.groth16.verify` — no code path returns `valid: true` without the verifier itself agreeing.

**Request body**:
```json
{ "proof": { "...": "as returned by /api/prove" }, "publicSignals": ["...", "...", "...", "...", "..."] }
```

**Response** `200`, real example (verifying the proof above):
```json
{ "valid": true, "verifyMs": 14 }
```
A garbage or mutated proof/publicSignals doesn't error — it returns `valid: false` with a `200`, since "this proof doesn't check out" is a legitimate answer, not a server failure.

**Errors**:
- `400` — missing fields:
  ```json
  { "error": "proof and publicSignals are required." }
  ```

```
curl -X POST http://localhost:3000/api/verify \
  -H 'content-type: application/json' \
  -d '{"proof":{...},"publicSignals":[...]}'
```

---

## `POST /api/tamper`

The kill-switch demo. Three distinct, structurally different rejection cases, selected via `mode`:

- **`"blocked_account"`** — proves for account 1005, a real, correctly-signed, above-threshold account that the custodian has flagged blocked in its own signed leaf. No `accountId` needed (always 1005). `threshold` and `tradeId` still required.
- **`"balance_mismatch"`** — claims a balance for the given `accountId` higher than what the custodian actually signed. Requires `accountId`, `threshold`, `tradeId`.
- **`"merkle_mismatch"`** — a genuinely-signed, genuinely-above-threshold, genuinely-unblocked account, but with its Merkle path corrupted. `accountId` optional (defaults to 1001); `threshold`, `tradeId` required. This is the one mode where the leaf itself is entirely real — only the claimed path to the root is wrong — so it isolates the Merkle check on its own, distinct from `balance_mismatch`, which now fails at the signature check instead (see below).

All three modes are *expected* to be rejected — that's the point of the demo. The response always names which one actually happened via `failedAt` and `actuallyRejected`.

**Request body** (`blocked_account`):
```json
{ "mode": "blocked_account", "threshold": 1000000, "tradeId": 1 }
```

**Response** `422`, real example:
```json
{
  "error": "The account is in the custodian's tree and clears the balance threshold, but the custodian's own leaf marks it blocked. The proof cannot be constructed.",
  "failedAt": "blocked",
  "mode": "blocked_account",
  "expectedRejection": true,
  "actuallyRejected": true
}
```

**Request body** (`balance_mismatch`):
```json
{ "mode": "balance_mismatch", "accountId": 1003, "threshold": 1000000, "tradeId": 1 }
```

**Response** `422`, real example:
```json
{
  "error": "This leaf's claimed balance and block status do not carry a valid signature from the known custodian key. The proof cannot be constructed.",
  "failedAt": "attestation",
  "mode": "balance_mismatch",
  "expectedRejection": true,
  "actuallyRejected": true
}
```
Note `failedAt` is `"attestation"`, not `"merkleRoot"` — since the custodian's signature now covers the claimed balance, a balance mismatch is caught by the signature check before the Merkle check is ever reached. (Before custodian attestation existed, this same case failed at the Merkle check instead — see `AUDIT.md` for the real, measured before/after.)

**Request body** (`merkle_mismatch`):
```json
{ "mode": "merkle_mismatch", "accountId": 1001, "threshold": 1000000, "tradeId": 1 }
```

**Response** `422`, real example:
```json
{
  "error": "The account named in this witness does not correspond to a leaf that hashes into the custodian's attested tree. The proof cannot be constructed.",
  "failedAt": "merkleRoot",
  "mode": "merkle_mismatch",
  "expectedRejection": true,
  "actuallyRejected": true
}
```

If a tamper request were ever to unexpectedly *succeed* (e.g. a caller raises `threshold` below 1005's real balance, which would make "blocked" the only thing stopping it — an artificial setup, but possible), the response is `200` with `actuallyRejected: false` rather than silently reporting it as a rejection.

**Errors**:
- `400` — invalid/missing `mode`, missing `threshold`/`tradeId`, missing `accountId` for `balance_mismatch`, or an unknown account:
  ```json
  { "error": "mode must be \"balance_mismatch\", \"blocked_account\", or \"merkle_mismatch\"." }
  ```

```
curl -X POST http://localhost:3000/api/tamper \
  -H 'content-type: application/json' \
  -d '{"mode":"blocked_account","threshold":1000000,"tradeId":1}'

curl -X POST http://localhost:3000/api/tamper \
  -H 'content-type: application/json' \
  -d '{"mode":"balance_mismatch","accountId":1003,"threshold":1000000,"tradeId":1}'

curl -X POST http://localhost:3000/api/tamper \
  -H 'content-type: application/json' \
  -d '{"mode":"merkle_mismatch","accountId":1001,"threshold":1000000,"tradeId":1}'
```

---

## `GET /api/status`

**Request**: no body.

**Response** `200`, real example:
```json
{
  "circuitVersion": "phase1-item2-attestation",
  "constraintCount": 6510,
  "circuitStats": {
    "nonLinearConstraints": 6510,
    "linearConstraints": 0,
    "privateInputs": 23,
    "publicInputs": 5,
    "source": "parsed from the circom compiler's own stdout at setup time",
    "generatedAt": "2026-09-07T12:08:18Z"
  },
  "blocklistActive": true,
  "attestationActive": true,
  "depth": 8
}
```
`blocklistActive`/`attestationActive` describe what's structurally compiled into `circuits/settlement.circom` right now — they are not runtime toggles a client can flip.

```
curl http://localhost:3000/api/status
```

---

## `GET /api/audit-log`

Persisted to `build/audit-log.jsonl` (append-only, one JSON object per line) — a server restart does not lose history; the in-memory cache is reloaded from that file at boot. This endpoint serves at most the 500 most recent entries regardless of how large the underlying file grows. Records every `/api/prove` and `/api/tamper` call. Deliberately excludes balance, salt, blocked, the signature, and Merkle path data — only enough to know what was asked and what happened.

**Request**: no body.

**Response** `200`, real example (after a handful of calls above):
```json
{
  "entries": [
    { "timestamp": "2026-09-07T12:17:08.808Z", "endpoint": "prove", "accountId": 1001, "result": "success", "reason": null },
    { "timestamp": "2026-09-07T12:17:09.162Z", "endpoint": "tamper", "accountId": 1005, "result": "rejected", "reason": "blocked", "mode": "blocked_account" },
    { "timestamp": "2026-09-07T12:17:09.423Z", "endpoint": "tamper", "accountId": 1003, "result": "rejected", "reason": "attestation", "mode": "balance_mismatch" },
    { "timestamp": "2026-09-07T12:17:09.452Z", "endpoint": "prove", "accountId": 9999, "result": "rejected", "reason": "invalid_input" }
  ],
  "count": 4,
  "maxEntries": 500
}
```

```
curl http://localhost:3000/api/audit-log
```

---

## Errors not tied to a specific endpoint

**Unknown route** — `404`, real example:
```
curl http://localhost:3000/api/nonexistent
```
```json
{ "error": "No route for GET /api/nonexistent." }
```

**Unexpected server error** — `500`, body `{ "error": "Internal server error." }`. Logged server-side via `console.error`; should not occur in normal operation — every expected failure mode above is handled with its own status code instead.
