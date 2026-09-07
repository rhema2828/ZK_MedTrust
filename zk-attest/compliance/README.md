# Compliance verification

Real 15-case dataset, screened against the 20 compliance criteria named in
the brief, with a real Groth16 circuit that proves "this case passes at
least N of its 20 checks" without revealing which checks passed, the
case's identity, or its raw fields.

## Setup

```
cd zk-attest
bash scripts/setup.sh              # if not already done — builds circom + the shared ptau
bash scripts/setup_compliance.sh   # compiles circuits/compliance.circom, reuses that ptau
node server/index.js
```

`compliance/compliance_cases.sql` is the single source of truth for the
dataset — `compliance/db.js` executes it verbatim into a real SQLite
database (`build/compliance.db`, Node's built-in `node:sqlite`, no native
module install) on every server boot. Edit the `.sql` file, restart the
server, done — there's no separate "re-import" step.

## What this actually proves

Given a public Merkle root (over the 15 committed cases), a public
pass-count threshold, a public proof nonce, and a public
compliance-authority signing key, the prover demonstrates that:

1. there exists a case in the authority's attested tree,
2. whose 20 real criteria results sum to at least the claimed threshold,
3. and whose full 20-result vector carries a valid EdDSA signature from
   that same authority key —

**without revealing which case it is, which of the 20 checks passed or
failed, or any of the case's raw fields (institution, amount, jurisdiction,
etc.).**

## What this does *not* prove — read this before claiming otherwise

- **Not an independent re-verification of the 20 checks.** The circuit
  proves a signed vector of pass/fail *results* sums correctly against a
  threshold. It has no way to know whether "sanctions = CLEAR" was actually
  true — that determination happened upstream (see "How the 20 results
  were actually determined" below), the same way settlement.circom's
  balance proof trusts whoever signed the balance, not an independent
  ledger.
- **The 20 criteria are not weighted or ranked.** A case that fails 2 of
  the most severe criteria (sanctions, fraud) and a case that fails 2 of
  the least severe (say, a reporting nicety) produce an identical
  `passCount`. The demo dataset's one flagged case (CASE-015) happens to
  fail 9 checks including sanctions, so this limitation doesn't bite in
  the sample data — but a real deployment would need either per-criterion
  weighting or hard-fail criteria that block regardless of the aggregate
  count (sanctions and fraud are the obvious candidates), neither of which
  this circuit implements.
- **Trust boundary: the compliance authority.** Exactly the same caveat
  settlement.circom documents for its custodian: the circuit proves "a
  signature from this specific public key exists over this specific
  20-result vector" — it cannot prove the authority actually ran honest
  checks before signing. Whoever publishes the root and the authority's
  public key is trusted, full stop.

## How the 20 results were actually determined

Two different mechanisms, by design — see `criteria.js` and
`ai-commentary.js`:

- **14 of the 20 criteria** are a closed, deterministic classification:
  the dataset's own status string for that column (`VERIFIED`, `CLEAR`,
  `PASS`, …) either equals the one passing value or it doesn't. There is
  no raw evidence left to independently re-derive here — these are already
  resolved statuses, the same way `zk-attest`'s account balances are
  already-resolved numbers, not something this system re-audits.
- **6 of the 20 criteria are risk judgments**, not status lookups
  (`counterparty_risk`, `jurisdiction_risk`, `transaction_pattern`,
  `fraud_risk`, `financial_health` feed the pass/fail bit the same way;
  `ai-commentary.js` additionally records a genuine, independently
  reasoned assessment of whether the given label is *plausible* given the
  case's real amount/currency/jurisdiction/purpose — performed once, by an
  actual model reading the real data, not fabricated boilerplate repeated
  per case, and not a live per-request API call this backend has no key to
  make. It's recorded and displayed the way a compliance analyst's sign-off
  would be, not re-derived on every page load.

## Circuit design notes (`circuits/compliance.circom`)

Deliberately mirrors two circuits already in this repo rather than
inventing new patterns — see the circuit's own comments for the specifics:
the leaf/attestation/Merkle-membership structure is `settlement.circom`'s,
applied to a compliance case instead of a treasury account; the
range-checked threshold comparison is `../../zk/circuits/accuracy.circom`'s
`AccuracyThreshold` pattern, applied to a sum-of-booleans instead of a
prediction count. The one new piece is the two-stage Poseidon leaf
(`group1`/`group2` pre-hashes over 10 bits each, folded into the leaf
alongside `caseIndex`/`salt`) — needed because circomlib's `Poseidon`
template supports at most 16 inputs per call, and this leaf commits 20.

6,439 non-linear constraints — reuses `zk-attest`'s existing 2^14
Powers-of-Tau ceremony (`scripts/setup.sh`) rather than running a new one,
since `2 * 6439 = 12878 < 16384`.
