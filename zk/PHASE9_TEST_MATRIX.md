# Phase 9 — Full Test Matrix

The brief's Phase 9 checklist, mapped to the actual test that covers each
item. This exists so coverage is auditable — click through and read the
test, don't take a checkbox's word for it.

Run everything in one command from the repo root: `bash run_all_tests.sh`.

## ZK sanity

| Item | Test |
|---|---|
| valid x²=y proof succeeds | `zk/test/square.test.mjs` → `"a valid proof verifies"` |
| modified public input fails | `zk/test/square.test.mjs` → `"tampering with the public input makes verification fail"` |
| modified proof fails | `zk/test/square.test.mjs` → `"tampering with the proof makes verification fail"` |

## Accuracy circuit

| Item | Test |
|---|---|
| valid threshold succeeds | `zk/test/accuracy.test.mjs` → `"a valid accuracy claim (90% >= 85%) verifies"` |
| accuracy below threshold fails | `zk/test/accuracy.test.mjs` → `"accuracy below threshold cannot produce a witness (80% < 85%)"` |
| `correct_predictions > total_predictions` fails | `zk/test/accuracy.test.mjs` → `"correct_predictions > total_predictions cannot produce a witness"` |
| `total_predictions = 0` fails | `zk/test/accuracy.test.mjs` → `"total_predictions = 0 cannot produce a witness"` |
| invalid threshold fails | `zk/test/accuracy.test.mjs` → `"threshold > 100 cannot produce a witness"` |

All five "fails" cases fail at **witness generation** — no witness exists
for these inputs at all, which is a stronger guarantee than "a proof gets
rejected" (see `circuits/accuracy.circom`'s header comment). Also exercised
independently, against the real evaluation pipeline rather than hand-typed
numbers, by `backend/test_zk_proof.py`'s `GenerateAccuracyProofTests`.

## Merkle

| Item | Test |
|---|---|
| valid inclusion proof succeeds | `zk/test/merkle.test.mjs` → `"a valid inclusion proof verifies against the real root"` |
| modified leaf fails | `zk/test/merkle.test.mjs` → `"a modified leaf value fails to verify"` |
| modified root fails | `zk/test/merkle.test.mjs` → `"a modified root fails to verify a genuine proof"` |
| modified record fails | `zk/test/merkle.test.mjs` → `"a tampered SOURCE record (before hashing) is caught by the leaf it produces"` |

## Protocol

| Item | Test |
|---|---|
| malformed proof rejected | `backend/test_zk_proof.py` → `"test_malformed_proof_does_not_verify_and_does_not_raise"` (bridge level) and `backend/test_security.py` → `"test_well_formed_but_garbage_proof_content_returns_false_not_a_crash"` (through the real HTTP route) |
| replayed ticket rejected | `backend/test_security.py` → `TicketTests.test_replayed_nonce_rejected` |
| expired ticket rejected | `backend/test_security.py` → `TicketTests.test_expired_ticket_rejected` |

**A deliberate call, not a gap:** the brief groups this as "replayed
proof/ticket." A Groth16 **proof** is intentionally *not* nonce-gated —
`/verify_proof`'s design (Phase 7) makes verification re-checkable by
anyone, any number of times, because that's the entire point of a
portable, publishable proof. Nonce/replay protection belongs on the
request that *creates* a proof (the ticket, above), not on checking one
that already exists. Gating verification itself would make proofs
useless for the auditing use case this project exists for.

## API

| Item | Test |
|---|---|
| `/generate_proof` produces a real proof | `backend/test_security.py` → `GenerateProofEndpointTests.test_valid_request_succeeds` (asserts `protocol: "groth16"` and `correct_predictions` absent from the response) |
| `/verify_proof` actually verifies it | `backend/test_security.py` → `VerifyProofEndpointTests.test_honest_proof_verifies_through_the_real_api` |
| invalid proof returns `zk_verified=false` | `backend/test_security.py` → `VerifyProofEndpointTests.test_tampered_proof_returns_zk_verified_false`, `test_tampered_public_signals_return_zk_verified_false`, `test_well_formed_but_garbage_proof_content_returns_false_not_a_crash` |

## Beyond the brief's checklist

Not required by Phase 9, but real coverage that exists anyway:

- Merkle determinism, order-sensitivity, empty/single-record edge cases
  (`zk/test/merkle.test.mjs`)
- Sampling determinism (50-repeat "nothing to re-roll" check), root/version
  sensitivity, index validity (`zk/test/sampling.test.mjs`)
- Witness assembly range checks matching the circuit's own constraints,
  boundary cases (`zk/test/witness.test.mjs`)
- Evaluation pipeline: image-integrity check catching a swapped file,
  aggregation correctness, real-model integration
  (`zk/evaluation/test_evaluate.py`)
- Full security-layer unit coverage: API key, rate limiting, tickets,
  secure tempfiles, model integrity (`backend/test_security.py`)
- Full `/generate_proof` ↔ `/verify_proof` round trip, including the exact
  claim-not-met → 422 path with no proof leaked into the error response

## Totals

120 tests passing (53 JS + 67 Python) as of Phase 9, all against the real
toolchain — `bash run_all_tests.sh` runs every suite in one command.
