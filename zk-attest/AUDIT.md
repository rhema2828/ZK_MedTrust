# ZK-Attest — implementation audit

Every number in this document was produced by actually running the toolchain
on this machine and reading the tool's own output — never estimated, never
carried over from a different circuit revision or a different session. Where
a number is superseded by a later circuit change (adding a signal shifts
every subsequent line number, for example), the old number is struck through
and dated, not silently deleted.

## Three-stage build table

| Stage | Non-linear constraints | Wires | Private inputs | Public inputs |
|---|---|---|---|---|
| Original (pre-audit baseline) | 2,270 | 2,283 | 19 | 3 |
| + Blocklist flag (`blocked` folded into leaf) | 2,303 | 2,316 | 20 | 3 |
| + Custodian EdDSA attestation | 6,510 | 6,524 | 23 | 5 |

Source for every row: `node_modules/.bin/snarkjs r1cs info build/settlement.r1cs`,
run against that stage's actual compiled `.r1cs`, in this repo's `zk-attest/`
worktree, 2026-09-07.

### Timing / proof size per stage (n=5, min/max/mean)

| Stage | proveMs | proofBytes | proof.json on disk (proof object only) |
|---|---|---|---|
| Original | 209 / 471 / 265.2 | 722 / 724 / 723.0 | 722 bytes |
| + Blocklist flag | 217 / 497 / 277.6 | 721 / 724 / 722.6 | 721 bytes |
| + Custodian attestation | 417 / 703 / 500.2 | 721 / 724 / 722.2 | 724 bytes |

Verify timing (n=5): original 10 / 14 / 11.6 ms; + attestation 10 / 12 / 10.6 ms.
Proving roughly doubled going from the blocklist stage to the attestation
stage (277.6ms mean -> 500.2ms mean) — consistent with constraints roughly
tripling (2,303 -> 6,510); verify time barely moved, since Groth16 verification
cost depends on public input count (3 -> 5), not overall constraint count.

Measured via 5 sequential `POST /api/prove` calls to a locally running
`node server/index.js`, account 1001, threshold 1,000,000, tradeId 1. Not a
cold-start number — first request of a run includes wasm/zkey warm-up
inside the process already, since the server loads `.zkey`/`.wasm` once at
boot per the brief; run 1 in each set includes that residual JIT warm-up,
which is why it's consistently the outlier (see run 1 = 471ms/497ms vs. a
tight 209-232ms band for runs 2-5).

## Blocklist / non-membership design note

The brief offered two options: a second Merkle tree with an explicit
non-membership proof, or a "blocked" flag folded into the existing leaf.
Implemented the second: `leaf = Poseidon(accountId, balance, salt, blocked)`,
with a hard constraint `blocked === 0`. This was chosen over a second tree
because it composes directly with custodian attestation (next stage): one
signature over one leaf now attests to both "this balance is real" and
"this account's block status," which is a more coherent claim than two
independently-signed facts. The tradeoff, stated plainly: this is
membership-with-a-flag, not a true non-membership proof against an
independently-published blocklist — a separate authority can't publish a
blocklist that binds accounts it doesn't already control leaves for. If a
future revision needs an externally-published, custodian-independent
blocklist, that requires the second-tree design instead.

One demo account is hardcoded blocked, backed by a real leaf and a real
constraint failure, not narration: account 1005 "Halcyon Trade Corp",
balance $9,800,000 (clears the $1M bar comfortably), `blocked: 1`. Proving
for it with no override at all — the honest path — fails at
`circuits/settlement.circom:84` (`blocked === 0`), confirmed by an actual
`POST /api/prove` call returning:
```
{"error":"Witness generation failed: Error: Assert Failed. Error in template Settlement_150 line: 84\n","failedAt":"unknown"}
```
(`failedAt` reads `"unknown"` here because `server/index.js`'s failure
classifier hadn't been updated for the new line numbers yet at the moment
this call was made — fixed in the same commit as this circuit change.)

Real failure lines for this stage, each confirmed by triggering it and
reading the actual witness-calculator error (not inferred from source):
- `merkleRoot` mismatch (balance-tamper case, account 1003 + `tamper: true`): line 75
- `threshold` (account 1003, no tamper — genuinely below $1M): line 81
- `blocked` (account 1005, no override needed): line 84

## Custodian attestation design note

`leaf.out` (Poseidon(accountId, balance, salt, blocked)) is verified in-circuit
against an EdDSA-Poseidon (Baby Jubjub) signature via circomlib's
`EdDSAPoseidonVerifier`, checked against a now-public `custodianPubKeyAx/Ay`.
Signing happens off-circuit in `scripts/build-tree.js` using `circomlibjs`'s
`eddsa.signPoseidon`, with a demo-deterministic custodian private key (SHA-256
of a fixed string — a real deployment would hold this outside the repo).

**Real, measured consequence for the trusted setup**: this pushed non-linear
constraints from 2,303 to 6,510 — enough that `snarkjs`'s own sizing check
rejected both the original 2^12 Powers-of-Tau ceremony *and* 2^13
(`6510*2 > 2**13` still fails); 2^14 was the minimum that fit. `scripts/setup.sh`
was updated accordingly (`POT_POWER=12 -> 14`) and a fresh ceremony generated —
the brief's own predicted "thing that breaks first" actually broke, exactly as
warned, and is being reported rather than silently bumped. Trusted-setup wall
time went from ~62s (original, cold) to 1m47s (2^14, cold) on this machine.

**Real, measured consequence for the tamper demo**: because the signature now
covers `balance` (not just the Merkle path), the existing balance-override
tamper case (`accountId: 1003, tamper: true`) no longer fails at the Merkle
check — it fails inside the EdDSA verifier itself, since the recomputed leaf
no longer matches what the custodian actually signed. Confirmed by an actual
call:
```
{"error":"Witness generation failed: Error: Assert Failed. Error in template ForceEqualIfEnabled_171 line: 56\nError in template EdDSAPoseidonVerifier_172 line: 117\nError in template Settlement_249 line: 90\n","failedAt":"unknown"}
```
(again `"unknown"` only because this call predates the classifier update in
the same commit). `server/index.js`'s `classifyWitnessFailure` was rewritten
to detect the `EdDSAPoseidonVerifier`/`ForceEqualIfEnabled` template names in
the error's call chain — a bare "last line number" match no longer
distinguishes this case from a genuine Merkle failure, since both now share
the same failure family for a tampered balance.

One consequence worth stating plainly: the API's `tamper: true` flag no
longer has a way to exercise a *pure* Merkle-path failure (wrong path, right
signature) — it only exercises the signature failure now, since both were
triggered by the same override. A pure Merkle-only failure (line 99) would
require a different kind of tamper (e.g. a corrupted `pathElements` array)
that the current API doesn't expose. Noted as a real gap, not fixed in this
pass — Phase 2's `/api/tamper` redesign is the place to decide whether it's
worth adding. **Fixed in the post-Phase-4 hardening pass below (item 3,
`mode: "merkle_mismatch"`) — this paragraph is left as-is to record what was
true at the time, not corrected in place.**

Real failure lines/signatures for this stage, each confirmed by triggering
it and reading the actual witness-calculator error (not inferred from
source, and not reused from the pre-attestation stage above, since every
line number shifted): `merkleRoot` — line 99, not independently exercised by
any current API call at the time this was written (see above, and see item
3 below for the fix); `threshold` — line 105, confirmed via account 1003
with no tamper; `blocked` — line 108, confirmed via account 1005;
`attestation` — no fixed line number, detected via
`EdDSAPoseidonVerifier`/`ForceEqualIfEnabled` appearing in the call chain,
confirmed via account 1003 + `tamper: true`.

## Phase 2 — API restructuring

All of the following was verified with real `curl` calls against a locally
running `node server/index.js` on this machine, 2026-09-07 (see commit for
exact transcripts):

- **`GET /api/book` (unauthenticated, all-institutions) is gone** — confirmed
  it now 404s. Replaced with `GET /api/book/treasury` (full institution list
  + balances + blocked flags — the custodian's own view) and
  `GET /api/book/exchange` (merkle root, tree depth, custodian public key,
  circuit stats — no institution names or balances at all). This is the
  actual fix for the item-7 audit finding from the earlier pass: the
  Exchange pane's data source is now structurally incapable of returning
  balance/identity data, not just conventionally expected not to ask for it.
- **`POST /api/verify`** response field renamed `ok` -> `valid` per the
  requested contract. Confirmed real: `{"valid":true,"verifyMs":14}` against
  a genuine proof.
- **`POST /api/tamper`** replaces the `tamper: true` flag that used to live
  inside `/api/prove`. Takes an explicit `mode`: `"blocked_account"` (no
  override needed — proves for the hardcoded-blocked account 1005) or
  `"balance_mismatch"` (the original override-balance mechanism, against a
  caller-supplied account). Confirmed real, both modes rejected as expected:
  `blocked_account` -> `{"failedAt":"blocked", ...}`; `balance_mismatch`
  (account 1003) -> `{"failedAt":"attestation", ...}` (not `"merkleRoot"` —
  see the Phase 1 attestation note above for why).
- **`GET /api/status`** returns `circuitVersion`, `constraintCount`
  (read from `circuit-stats.json`, not hand-typed), and
  `blocklistActive`/`attestationActive` (both `true`, describing what's
  structurally baked into the compiled circuit — not runtime toggles).
- **`GET /api/audit-log`** — in-memory only, cleared on restart, capped at
  500 entries. Records `endpoint`, `accountId`, `result`, `reason`
  (and `mode` for tamper calls) for every `/api/prove` and `/api/tamper`
  call. Deliberately excludes balance, salt, blocked, the signature, and
  all Merkle path data — none of that belongs in a log even though it's
  already private-witness-only within a single request.
- **Error handling**: every endpoint validates its inputs and returns 400
  for missing/invalid fields or an unknown account, 422 for a witness that
  fails to generate (an expected outcome, not a server error), 404 for an
  unmatched route, and a caught-and-logged 500 (via Express error
  middleware) for anything genuinely unexpected — confirmed none of these
  paths silently 500 by triggering each one directly.
- **CORS**: `cors()` with no origin restriction, confirmed via an actual
  preflight `OPTIONS` request returning `Access-Control-Allow-Origin: *`.

## Phase 3 — API documentation

`API_CONTRACT.md` written: every endpoint, request/response shape, and
error shape, with real example JSON captured from actual `curl` calls
against a running server (not invented). Every documented `curl` command
was then re-run end-to-end against a fresh server instance as a
consistency check before this commit — all matched.

## Phase 4 — README / final doc pass

No separate pitch document was ever located (checked full-text across
every `.md` file and by filename, repo-wide, at the start of this task —
none existed). `zk-attest/README.md` was written instead — this was
`checkpoint 6` from the original project brief, never completed in any
prior session. It states, explicitly and using only the measured numbers
above: Poseidon (not SHA-256), real proof size ~721-725 bytes (not "1KB"),
no `verifier.sol`/gas claim (none exists), the block-flag mechanism
described accurately as membership-with-a-flag rather than an independent
non-membership proof, "Travel Rule" scope stated as what it actually is
(a point-in-time screened/signed/not-blocklisted attestation, not FATF data
transfer), and the custodian trust boundary (whoever holds the signing key
is trusted; the circuit cannot verify the custodian was honest when it
signed) stated as its own section rather than left implicit.

## Post-Phase-4 backend hardening

Follow-up pass addressing the gaps identified after Phase 4, backend-only
(no frontend work), in priority order:

### 1. Automated test suite

`server/index.js` refactored to export `app` and only call `.listen()` when
run directly (`require.main === module`), so it can be imported and bound
to an ephemeral port in tests without touching the real port 3000.

`test/server.test.mjs` — 18 tests via Node's built-in test runner, against
the real exported `app`, with real proving and real `snarkjs.groth16.verify`
calls (no mocking). Run with `npm test`. Covers: both book views (including
that `/api/book/exchange` genuinely contains no institution data anywhere
in its JSON, not just that it omits a field), the old `/api/book` 404,
`/api/status`'s real constraint count, `/api/prove`'s success path
(asserting the exact response key set — no PII leaks in), all three
documented `failedAt` values (`threshold`, `blocked`, `attestation`),
`/api/verify` on both a genuine and a mutated proof, input validation on
every POST endpoint, the 404 handler, a live CORS header check (not just
preflight), and that every audit-log entry's keys are a subset of the
documented, PII-free set. All 18 pass:
```
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

### 2. `scripts/setup.sh` idempotency fix

Added STEP 3c: hashes `circuits/settlement.circom` (SHA-256) and compares
against the hash recorded from the last build (`build/circuit.sha256`); also
records and compares `POT_POWER` (`build/pot_power.txt`). A mismatch on
either clears exactly the artifacts that are actually stale (zkey files for
a circuit change; ptau + zkey files for a `POT_POWER` change) before the
existing STEP 4/5 existence-checks run.

**Verified real, not just written**: appended a comment line to
`settlement.circom`, re-ran `setup.sh`, confirmed it printed the
invalidation message and produced a `settlement_final.zkey` with a
genuinely different SHA-256 (`519ea468...` -> `d7b0125e...`), in 17.6s (ptau
correctly reused, only the zkey step re-ran — not the full 1m47s cold
ceremony). Reverted the edit, re-ran again, confirmed the original zkey
came back and all 18 tests still pass. A no-op re-run with nothing changed
stays fast (2.65s) and doesn't false-positive-invalidate anything.

### 3. `mode: "merkle_mismatch"` — isolating the Merkle check

`build-tree.js`'s `witnessFor` gained a `corruptPath` option: flips one bit
of the first `pathElement` while leaving balance, salt, blocked, and the
signature all genuine. `POST /api/tamper` exposes this as
`mode: "merkle_mismatch"` (defaults to account 1001 if `accountId` is
omitted). This is the one tamper mode where everything about the leaf
itself is real — only the claimed path to the root is wrong — so it's the
only way left to demonstrate the Merkle check failing on its own, now that
`balance_mismatch` is caught by the signature check first.

**Verified real**: `POST /api/tamper {"mode":"merkle_mismatch","accountId":1002,...}`
returns `{"failedAt":"merkleRoot", ...}` — confirmed distinct from both
`"attestation"` (balance_mismatch) and `"blocked"` (blocked_account).
Regression-checked that a normal honest `/api/prove` call and both existing
tamper modes still behave identically after this change. Two new tests
added to `test/server.test.mjs` (20/20 passing total).

### 4. Persistent audit log

`recordAudit` now appends every entry to `build/audit-log.jsonl` (one JSON
object per line) in addition to the existing in-memory array, and the
in-memory array is now seeded from that file at server startup — so a
restart no longer loses history, only the endpoint's in-memory cap (500)
still applies to what's *served*, not what's *kept*. File writes are
best-effort (wrapped in try/catch, logged via `console.error`, never fail
the underlying `/api/prove` or `/api/tamper` request) since audit logging
is not on the critical path of proving.

**Verified real**: made 3 calls, restarted the server, confirmed
`GET /api/audit-log` still returned all 3 prior entries plus new ones
appended after restart — genuinely tested by killing and restarting the
process, not just re-reading the same in-memory array.

## Second follow-up pass: custodian key overridability

`build-tree.js`'s custodian key seed is now `process.env.CUSTODIAN_KEY_SEED
|| <fixed demo string>`, with `isUsingDefaultCustodianKey()` exported so
`server/index.js` can warn loudly (not silently) at boot when the demo
default is active. This does not solve real key custody (that needs
HSM/KMS infrastructure, not code) — it removes the narrower problem that
the key was previously *forced* to be a hardcoded, unconditional secret in
source with no override path at all.

**Verified real**: confirmed the boot warning appears with no env var set
and is absent with `CUSTODIAN_KEY_SEED` set; confirmed
`getCustodianPubKey()` returns a genuinely different `Ax`/`Ay` pair under
an overridden seed (`5865220...`/`9709176...` -> `2622926...`/`6639550...`);
confirmed the Merkle root is unchanged under an overridden seed, correctly,
since the root commits to leaf content (accountId/balance/salt/blocked),
not to the signing key. All 20 tests still pass with no code path touched
by the tests themselves changed.

Trade-ID reuse across proofs (the other stated gap) was deliberately left
alone — see the note in the chat: it needs a product decision (what
"single-use" should even mean for an attestation that's meant to clear
multiple trades during its validity period) before it's a matter of
writing code, not after.

## Pending from this pass

- Trade-ID reuse / attestation freshness — a design decision, not
  implemented. Everything else from both post-Phase-4 passes is done.
