# ZK-Attest

A hackathon demo: a hedge fund or corporate treasury proves to an exchange
that some account in a custodian bank's committed Merkle tree holds a
balance above a threshold — and that the custodian has not flagged that
account blocked — without revealing which account it is or what its
balance actually is.

Frozen-then-extended Circom circuit + `snarkjs` Groth16 + a thin Express
API. No frontend is included in this backend (`web/` is a placeholder for
one built separately against `API_CONTRACT.md`).

Every number in this document is measured, not estimated — see `AUDIT.md`
for the full methodology and every command that produced these numbers.

## What this actually proves

Given a public Merkle root (published by the custodian), a public dollar
threshold, a public trade ID, and a public custodian signing key, the
prover demonstrates that:

1. there exists an account in the custodian's attested tree,
2. whose committed balance exceeds the threshold,
3. which the custodian has not flagged blocked,
4. and whose balance, block status, and account ID all carry a valid
   EdDSA signature from that same custodian key —

**without revealing which account it is, its actual balance, or its actual
block status.**

## What this does *not* prove — read this before claiming otherwise

- **Not a non-membership proof against an independently published
  blocklist.** The block flag is folded into each account's own leaf and
  signed by the same custodian that attests to its balance. This is
  membership-with-a-flag, not a separate authority publishing a blocklist
  that could bind accounts it doesn't already control leaves for. If your
  compliance model requires an external, custodian-independent sanctions
  list, this circuit does not implement that — it would need the
  second-Merkle-tree design instead of the flag design used here.
- **Not FATF Travel Rule compliance.** What this proves is: *at the moment
  of attestation*, the custodian screened this specific account, signed
  its balance, and did not flag it blocked. That is a real, useful, narrow
  claim. It is not a substitute for the data transfer FATF's Travel Rule
  actually mandates between VASPs (originator/beneficiary name, address,
  account number, etc.) — none of that is what this system carries, by
  design, since the entire point is that no such data crosses the proof
  boundary. Do not describe this as "Travel Rule compliant." Describe it as
  what it is: a point-in-time screened-and-signed-and-not-blocklisted
  attestation.
- **Trust boundary: the custodian.** Every guarantee in this system is
  downstream of one fact the circuit cannot verify: that the entity
  holding the custodian's private key actually checked the real balance
  and real sanctions status before signing. The circuit proves "a
  signature from this specific public key exists over this specific
  claim" — it has no way to prove the custodian was honest when it signed.
  Whoever publishes `merkleRoot` and `custodianPubKeyAx/Ay` is trusted,
  full stop; nothing here is trustless with respect to the custodian
  itself. A verifier is only as safe as their trust in whoever holds that
  one private key.
- **No on-chain component.** No `verifier.sol` exists anywhere in this
  repository, and no gas cost is claimed for verifying a proof — there is
  nothing on any chain to measure. Verification here means calling
  `snarkjs.groth16.verify()` in a Node process (see `POST /api/verify`),
  not an on-chain transaction.
- **Trade-ID binding stops replay of *this* proof, not re-use of the
  underlying attestation.** Squaring `tradeId` in-circuit means a proof
  generated for trade 42 cannot be replayed as a proof for trade 43. It
  does not stop the same custodian-signed leaf from being used to generate
  a *fresh, new* proof for a different trade — that would need a
  one-time-use nonce burned by the verifier, which is not implemented.

## Real, measured numbers

| | Value |
|---|---|
| Merkle hash | **Poseidon** (not SHA-256) |
| Custodian signature | EdDSA-Poseidon over Baby Jubjub (circomlib's `EdDSAPoseidonVerifier`) |
| Non-linear constraints (current circuit) | **6,510** |
| Public inputs | 5 (`merkleRoot`, `threshold`, `tradeId`, `custodianPubKeyAx`, `custodianPubKeyAy`) |
| Private inputs | 23 |
| Proving time (n=5, min/max/mean) | 417 / 703 / 500.2 ms |
| Verification time (n=5, min/max/mean) | 10 / 12 / 10.6 ms |
| Proof size on disk (proof object only) | **~721-725 bytes** (not "1KB" — measured directly, see `AUDIT.md`) |
| Trusted setup (2^14 Powers-of-Tau, cold) | 1m47s on this machine |
| On-chain verifier / gas cost | **none — not built, not claimed** |

The circuit evolved in three measured stages (original -> +blocklist flag ->
+custodian attestation); the full per-stage breakdown, including *why*
proving time roughly doubled and why the trusted-setup ceremony size had to
be bumped from 2^12 to 2^14, is in `AUDIT.md`.

## The two rejection cases

`POST /api/tamper` exercises two structurally different, real rejections:

- **`blocked_account`** — a real, correctly-signed, above-threshold account
  (1005) that the custodian has flagged blocked. Fails at the circuit's
  `blocked === 0` constraint.
- **`balance_mismatch`** — a claimed balance that doesn't match what the
  custodian actually signed for that account. Fails **inside the EdDSA
  signature check**, not the Merkle check — because the signature covers
  the claimed balance, tampering with it breaks the signature before the
  Merkle path is even evaluated. (Before custodian attestation existed,
  this same tamper case failed at the Merkle check instead; see `AUDIT.md`
  for the measured before/after.)

Both are real hard-constraint failures — witness generation itself fails,
not a post-hoc rejection of an otherwise-valid proof.

## Repository layout

```
zk-attest/
├── circuits/settlement.circom   # Merkle membership + threshold + block flag + custodian signature
├── scripts/setup.sh             # compile + trusted setup, idempotent (see caveat in AUDIT.md)
├── scripts/build-tree.js        # custodian tree, per-leaf signing, witness generation
├── server/index.js              # Express API — see API_CONTRACT.md
├── web/                         # placeholder — no frontend built here
├── build/                       # gitignored: .r1cs, .wasm, .zkey, .ptau
├── AUDIT.md                     # every measured number, methodology, and every gap found
└── API_CONTRACT.md              # full API reference for building a frontend against this backend
```

## Getting started

See "Running the server" in `API_CONTRACT.md` — it has the exact commands,
the real first-run timing, and the idempotency caveat.

## Testing

```
bash scripts/setup.sh   # build artifacts must exist first
npm test
```

18 tests (`test/server.test.mjs`), run against the real exported Express
`app` on an ephemeral port — no mocked proving or verification. Covers
every endpoint's success path, every documented `failedAt` case
(`threshold`, `blocked`, `attestation`), input validation, 404/CORS
behavior, and that the audit log never records a private witness field.
All 18 currently pass.

## Known gaps (stated plainly, not buried)

- The custodian's private signing key in this demo is deterministic
  (derived from a fixed string in `build-tree.js`) so the demo reproduces
  identically on any machine. A real deployment would hold this key
  outside the repository entirely, in an HSM or equivalent.
- No mechanism exists to prevent the *same* signed leaf from being used to
  generate proofs for many different trade IDs — see "trade-ID binding"
  above.
- `scripts/setup.sh`'s existence-check idempotency does not detect a
  changed circuit source; editing `circuits/settlement.circom` requires
  manually clearing `build/s_0000.zkey`, `build/settlement_final.zkey`, and
  `build/verification_key.json` before re-running, or you silently get a
  zkey for the wrong circuit. Not fixed in this pass — see `AUDIT.md`.
- `/api/audit-log` is in-memory only; it does not survive a server
  restart and is not a substitute for real persistent logging in any
  non-demo deployment.
