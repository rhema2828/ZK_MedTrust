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
| + Custodian EdDSA attestation | _pending_ | _pending_ | _pending_ | _pending_ |

Source for every row: `node_modules/.bin/snarkjs r1cs info build/settlement.r1cs`,
run against that stage's actual compiled `.r1cs`, in this repo's `zk-attest/`
worktree, 2026-09-07.

### Timing / proof size per stage (n=5, min/max/mean)

| Stage | proveMs | proofBytes | proof.json on disk (proof object only) |
|---|---|---|---|
| Original | 209 / 471 / 265.2 | 722 / 724 / 723.0 | 722 bytes |
| + Blocklist flag | 217 / 497 / 277.6 | 721 / 724 / 722.6 | 721 bytes |
| + Custodian attestation | _pending_ | _pending_ | _pending_ |

Verify timing, original circuit only so far (n=5): 10 / 14 / 11.6 ms.

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

## Pending from this pass

- Custodian EdDSA attestation (Phase 1 item 2) — not yet implemented at the
  time of this AUDIT.md revision; will shift every line number above the
  leaf computation again once added, and this table will be updated with a
  freshly re-verified set of failure lines, not the ones above.
- Phase 2 (API split, `/api/tamper`, `/api/status`, `/api/audit-log`, CORS)
  — not started.
- Phase 3 (`API_CONTRACT.md`) — not started.
- Phase 4 (pitch/README claim rewrite) — blocked on locating an actual
  pitch document; none was found anywhere in this repo as of this session
  (checked full-text across every `.md` file and by filename). If one
  exists outside this repo, it still needs to be provided before its claims
  can be checked against code.
