# ZK_MedTrust — Zero-Knowledge Layer

This directory holds the zero-knowledge proof system for ZK_MedTrust.
It is being built in phases. **Phase 1 is complete; phases 2–10 are not built yet.**

---

## What Phase 1 is (and is not)

Phase 1 does **not** prove anything about medical accuracy. It is a *toolchain
sanity check*: a deliberately trivial circuit that proves

> "I know an `x` such that `x * x = y`"

...where `x` stays secret and only `y` is revealed. The point is to confirm that
the whole chain — Circom → witness → Groth16 setup → prove → verify — genuinely
works, and genuinely *rejects* bad proofs, before anything important is built on
top of it.

Every later phase depends on this being real rather than a mock.

## What this does NOT prove

Read this before writing any claim about the project.

- **It is not a medical claim.** The ResNet-18 head in
  `backend/ml_inference.py` is *randomly initialised* (seed 42, untrained). The
  model's `Normal`/`Abnormal` outputs are structurally real but not
  diagnostically meaningful.
- **A ZK proof proves a mathematical statement, not the truth of its inputs.**
  Later phases will prove `correct * 100 >= threshold * total`. That proves
  arithmetic about supplied evaluation results. It does not prove the model is
  clinically correct, nor that the evaluation data is representative.
- Keep three things separate in your head, and in your writing:
  1. ML inference
  2. Model evaluation
  3. Cryptographic proof

---

## Prerequisites

| Tool | Version used | How it is obtained |
|---|---|---|
| Node.js | ≥ 18 (tested on 22) | pre-existing |
| Rust / cargo | 1.94 | needed only to build circom |
| circom | 2.2.2 | **built from source** — see below |
| snarkjs | 0.7.6 | `npm install` |

### Why circom is built from source

`circom` is not published to npm and not published to crates.io. The normal
install path is a prebuilt binary from GitHub Releases, but `api.github.com` is
blocked by this environment's egress policy, so `scripts/install_toolchain.sh`
clones the pinned tag `v2.2.2` and runs `cargo install`. Takes a few minutes the
first time, then it is cached.

---

## Setup and run

```bash
cd zk

# 1. Install circom (builds from source) + snarkjs. Idempotent.
bash scripts/install_toolchain.sh

# 2. Generate the Powers-of-Tau ceremony file. Read the warning it prints.
bash scripts/ptau.sh

# 3. Full Phase 1 demonstration: compile, prove, verify, and two negative tests.
bash scripts/phase1_square.sh

# 4. The same assertions as an automated test suite.
npm test
```

If `circom` is not found after step 1, add `$HOME/.cargo/bin` to your `PATH`.

---

## ⚠ The trusted setup is NOT trustworthy

Groth16 needs a "Powers of Tau" ceremony file. In production you use one produced
by a large multi-party ceremony (e.g. Hermez / Perpetual Powers of Tau), where
security holds as long as *at least one* participant destroyed their secret.

That file cannot be downloaded from this environment (`storage.googleapis.com`
returns 403). So `scripts/ptau.sh` generates one locally, with a single
contribution, on one machine.

**Consequence:** the proofs are genuine Groth16 proofs and the verifier genuinely
checks them — but whoever ran `ptau.sh` holds the toxic waste and could forge a
proof that verifies. This is fine for a demo. It is not fine for production, and
the README, the scripts, and eventually the API response all say so.

To swap in a real ceremony file, set one variable — nothing else changes:

```bash
PTAU_FILE=/path/to/powersOfTau28_hez_final_12.ptau bash scripts/phase1_square.sh
```

---

## The Phase 1 circuit

`circuits/square.circom`:

```circom
template Square() {
    signal input x;   // PRIVATE — never leaves the prover
    signal input y;   // PUBLIC  — the verifier sees this
    y === x * x;
}
component main {public [y]} = Square();
```

**Public inputs:** `y`
**Private inputs:** `x`

In circom, inputs are private by default; only what is listed in
`{public [...]}` is revealed. The verifier receives `proof.json` and
`public.json` — and `public.json` contains exactly `["49"]`. `x = 7` appears
nowhere in either file.

`y` is written as a public *input* checked with `===` rather than as an output
signal. That is deliberate: it is the same shape the Phase 5 accuracy circuit
will have (`threshold` and `total` public, per-sample results private), so the
pattern carries forward unchanged.

Compiled size: **1 non-linear constraint, 3 wires, 1 public input, 1 private input.**

---

## What the scripts do

| Script | Purpose |
|---|---|
| `scripts/install_toolchain.sh` | Builds/installs circom, installs snarkjs. Skips whatever is already present. |
| `scripts/ptau.sh` | Generates and caches the (development-only) Powers-of-Tau file at 2^12. |
| `scripts/phase1_square.sh` | The full demonstration, including both negative tests. Exits non-zero if a tampered input ever verifies. |

`scripts/phase1_square.sh` walks eight steps: compile → witness → Groth16 setup →
export verification key → prove → verify → tamper with the public input → tamper
with the proof. A tampered case that verifies is treated as a hard failure, not
a warning.

## Tests

`test/square.test.mjs` drives snarkjs through its JavaScript API and asserts:

1. an honest proof verifies
2. changing the public input (`49` → `50`) makes verification fail
3. changing the proof (nudging `pi_a[0]`) makes verification fail
4. a false statement (`x=7, y=50`) cannot even produce a witness

Run with `npm test`. Requires `scripts/phase1_square.sh` to have been run first,
so the build artifacts exist.

## Layout

```
zk/
├── circuits/square.circom      the Phase 1 circuit
├── scripts/                    install, ceremony, demonstration
├── merkle/                     Phase 2: canonicalize, hash, tree, CLI
├── data/sample_dataset.json    Phase 2: synthetic demo dataset
├── test/                       automated sanity + Merkle assertions
├── build/                      ALL generated — gitignored
├── package.json
└── README.md
```

Nothing in `build/` is committed: `.wasm`, `.r1cs`, `.zkey`, `.ptau`,
`commitment.json` and `proofs.json` are all generated artifacts.

## Known issue

`npm audit` reports 3 high-severity advisories in `underscore`, reached
transitively via `snarkjs → bfj → jsonpath`. There is no upstream fix that does
not break snarkjs, and the affected code path (JSON streaming) is not reachable
from how we call snarkjs. Left as-is deliberately rather than force-resolved.

---

# Phase 2 — Merkle Dataset Commitment

Phase 2 is the piece that lets a hospital commit to *which* evaluation records
it is claiming accuracy over, before it runs the model or reveals anything.
Once a root is published, nobody — not even the hospital — can quietly swap a
record for a friendlier one without the root changing.

## What is in a leaf

An evaluation record is one (image, ground-truth label) pair. Exactly four
fields make up the commitment (`merkle/canonicalize.mjs`):

| Field | Meaning |
|---|---|
| `record_id` | a unique identifier for this record within the dataset |
| `image_sha256` | SHA-256 of the **raw image bytes**, as 64 lowercase hex chars |
| `ground_truth` | `"Normal"` or `"Abnormal"` (matches `ml_inference.CLASSES`) |
| `dataset_version` | a label for which dataset/version this record belongs to |

`image_sha256` is a hash of image *content*, not a file path. A path can be
repointed at a different file after the commitment is published; a content
hash cannot be — recomputing it from the swapped-in image produces a
different digest, which produces a different leaf, which produces a
different root. Computing that hash from the actual image file is Phase 4's
job (it owns the image I/O); this module only ever sees the digest.

Any record missing a field, with an unrecognised `ground_truth`, or a
malformed `image_sha256` is rejected outright — nothing incomplete ever gets
hashed into a commitment.

## How records are canonicalized

`canonicalizeRecord()` turns the four fields into one fixed string:

```
${record_id}|${image_sha256}|${ground_truth_code}|${dataset_version}
```

where `ground_truth_code` is `"0"` for Normal and `"1"` for Abnormal. Field
order in the input object never matters — only these four named fields are
read, in this fixed order, with this fixed delimiter. No JSON serialization,
so there's no key-ordering or number-formatting ambiguity to worry about.

## What hash function is used, and why two of them

| Step | Hash | Why |
|---|---|---|
| record → leaf | SHA-256, reduced mod the BN254 scalar field | standard, arbitrary-length input, runs once outside any circuit |
| combining tree nodes | Poseidon (via `circomlibjs`) | "SNARK-friendly" — a handful of constraints per hash inside a circom circuit, vs. thousands for SHA-256. Phase 6 will need to re-verify a Merkle path *inside* a circuit, and `circomlibjs`'s Poseidon is bit-for-bit the same implementation circomlib's `Poseidon()` circuit template uses, so a tree built here and a path checked in-circuit later agree. |

A SHA-256 digest is 256 bits; Poseidon operates on BN254 scalar-field
elements, which are slightly under 254 bits. So every digest is reduced
`mod p` before use (`merkle/poseidon.mjs`). This throws away on the order of
2 bits of a 256-bit digest — cryptographically irrelevant, and it's what
lets the same number be re-used later as a circuit signal.

## How the Merkle root commits to the dataset

Leaves are combined pairwise, bottom-up: `parent = Poseidon(left, right)`,
until one value — the root — remains. **Record order is part of the
commitment**: the same records in a different order produce a different
root (verified by test). This is intentional, not a limitation — Phase 3's
sample indices are only meaningful relative to one fixed, agreed ordering.

Padding: the tree needs a power-of-two leaf count. Unused slots are padded
with the field element `0`, not a duplicated real leaf. Duplicating the last
leaf is a well-known way to make two genuinely different datasets collide on
the same root; using a fixed sentinel that a real SHA-256 digest can only
hit with ~2⁻²⁵⁴ probability avoids that without adding a new algorithm to
explain.

**The same dataset always produces the same root** (`Merkle: same dataset
always produces the same root`, verified across independent Node
processes) — and **changing, reordering, or dropping any single record
changes the root** (also directly tested).

## Inclusion proofs

`tree.getProof(index)` returns the leaf plus one `{sibling, isRight}` entry
per tree level. `verifyInclusionProof(leaf, path, root)`
(`merkle/merkleTree.mjs`) is the standalone check a verifier runs: it knows
nothing about the rest of the dataset, only a claimed leaf, its path, and
the published root, and recomputes Poseidon up to the top to see if it
lands on that root.

## Try it

```bash
cd zk
node merkle/commitDataset.mjs data/sample_dataset.json
```

Reads the six-record **synthetic** demo dataset (`data/sample_dataset.json`
— placeholder image hashes over synthetic content strings, not real patient
data, clearly labeled as such in the file's generation) and writes:

- `build/commitment.json` — the public commitment: root + one leaf hash per
  record. This is what actually gets published/handed to a verifier.
- `build/proofs.json` — an inclusion proof for every record. Materializing
  *all* of them is a convenience for this demo and for tests; a real prover
  computes a proof only for the specific indices Phase 3 selects, on
  demand.

## Tests

`test/merkle.test.mjs` — canonicalization edge cases, plus the four cases
the project brief calls for: a valid inclusion proof succeeds; a modified
leaf fails; a modified root fails; a modified source record fails (because
it changes the leaf it hashes to) — run with `npm test`.

## Roadmap

| Phase | Status |
|---|---|
| 1. Toolchain sanity (`x*x=y`) | ✅ done |
| 2. Merkle dataset commitment | ✅ done |
| 3. Cryptographically bound sampling | not started |
| 4. Evaluation pipeline | not started |
| 5. Accuracy circuit (`correct*100 >= threshold*total`) | not started |
| 6. Merkle + sampling + ZK wiring | not started |
| 7. FastAPI `/generate_proof` + `/verify_proof` | not started |
| 8. Security layer | not started |
| 9. Full test matrix | not started |
| 10. Documentation | not started |
