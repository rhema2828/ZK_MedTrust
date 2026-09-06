# ZK_MedTrust — Zero-Knowledge Layer

This directory holds the zero-knowledge proof system for ZK_MedTrust.
It is being built in phases. **Phases 1-9 are complete; Phase 10 (final documentation) is in progress.**

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

- **It is not a clinically validated claim.** `backend/ml_inference.py` wraps
  torchxrayvision's `densenet121-res224-all` — a real model trained on real
  chest X-ray datasets (see `CLAUDE.md`) — but nothing here is validated for
  diagnostic use. The model's `Normal`/`Abnormal` outputs are real, trained
  predictions, not a clinical diagnosis.
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
has (`threshold` and `total_predictions` public, `correct_predictions`
private), so the pattern carries forward unchanged.

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
├── circuits/accuracy.circom    Phase 5: the accuracy-threshold circuit
├── scripts/                    install, ceremony, demonstration
├── merkle/                     Phase 2: canonicalize, hash, tree, CLI
├── sampling/                   Phase 3: bound sample selection, CLI
├── evaluation/                 Phase 4: runs the existing model, scores it (Python)
├── witness/                    Phase 6: evaluation output -> circuit witness
├── data/sample_dataset.json    Phase 2/4: synthetic demo dataset
├── data/images/                Phase 4: synthetic demo images
├── test/                       automated sanity + Merkle + accuracy + witness assertions
├── build/                      ALL generated — gitignored
├── package.json
└── README.md
```

`backend/security.py` + `backend/test_security.py` (Phase 8) live under
`backend/`, not `zk/`, since they protect the FastAPI endpoints rather than
being part of the cryptography itself.

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

---

# Phase 3 — Cryptographically Bound Sampling

Phase 2 lets a hospital commit to a whole dataset. Phase 3 decides *which*
records from that dataset actually get evaluated for the accuracy claim —
without letting the hospital quietly pick the easy ones.

## The problem being solved

If sample selection were `random.sample(dataset, k)` run locally by the
prover, nothing stops them from running it 500 times, privately, until they
land on a subset their model happens to get right, and only generating a
proof over *that* subset. The proof itself would be completely genuine
Groth16 — and completely meaningless, because the sample was cherry-picked.

## The fix: derive the sample from the commitment, not from chance

```
dataset  --(Phase 2)-->  root  --(Phase 3)-->  seed  -->  selected indices
```

`sampling/selectSamples.mjs` implements this in two steps, both pure
functions of already-public values:

1. **Seed.** `seed = SHA256(root | dataset_version | sample_size)`. All
   three inputs are things a verifier already has from the published
   commitment — this "randomness" is not random at all, it's a fixed hash
   of fixed public values.
2. **Expand.** For a counter `i = 0, 1, 2, …`: `candidate = SHA256(seed ":" i)
   mod record_count`. Keep the first `sample_size` *distinct* candidates —
   duplicates are skipped, which is what makes this "without replacement."
   Return the result sorted ascending (only the *set* of indices matters,
   not discovery order).

Once a root is published, the sample it implies is already fixed. There is
no "try again" step: trying again means presenting a different root, which
is a different, publicly visible commitment to a (possibly different)
dataset — not a private retry of the same one.

## What a verifier does

`verifySelection(root, dataset_version, record_count, sample_size,
claimedIndices)` recomputes the same two steps independently and checks the
result against what the prover claims to have evaluated. It needs nothing
private — just the four public values already on the commitment plus the
prover's claimed index list.

## Try it

```bash
cd zk
node merkle/commitDataset.mjs data/sample_dataset.json   # Phase 2, if not already run
node sampling/selectFromCommitment.mjs 3
```

Reads `build/commitment.json` and `build/proofs.json`, selects 3 of the 6
demo records, and writes `build/selection.json`: the root, the seed, the
selected indices, and — for convenience — each selected record's inclusion
proof from Phase 2, so Phase 4 can pick up straight from this file.

## What this does — and does not — protect against

Binding the sample to the root stops re-rolling samples **for a fixed,
already-published dataset**. It does **not** by itself stop a curator from
constructing several different-but-superficially-legitimate datasets ahead
of time and only publishing the root of whichever one happens to produce a
favorable sample — that "shop around before committing" gap needs an
unpredictable input the curator doesn't control (e.g. a public randomness
beacon, or an independent auditor's nonce) mixed into the seed. Not
implemented here; noted so this file isn't read as claiming more than it
provides.

## Tests

`test/sampling.test.mjs` — determinism (same root/version/size always
yields the same indices, 50 repeated calls included as a direct
"there is nothing to re-roll" check), sensitivity to root and to
dataset_version, index validity (unique, in-range, correct count), and
`verifySelection` accepting the genuine selection while rejecting a
swapped index, the wrong root, or the wrong length.

---

# Phase 4 — Evaluation Pipeline

Phase 4 runs the **existing, unmodified** `MedicalDiagnosticsModel`
(`backend/ml_inference.py`) over exactly the records Phase 3 selected, and
turns its outputs into the `correct_predictions` / `total_predictions`
numbers Phase 5's circuit will prove a threshold over. Nothing in
`backend/` is changed by this phase — not one line.

```
build/selection.json (Phase 3)
        |
        v
for each selected record:
    re-verify the image file's SHA-256 against what Phase 2 committed to
        |
        v
    MedicalDiagnosticsModel.predict(image)   <- the EXISTING model, as-is
        |
        v
    compare prediction to ground_truth -> correct (0 or 1)
        |
        v
correct_predictions, total_predictions  ->  build/evaluation.json
```

## Why Python, when Phases 1–3 are JavaScript

The Merkle/sampling tooling is JS because it leans on `circomlibjs`'s
Poseidon (Phase 2 explains why). Reusing the *existing* model means reusing
*existing Python code* — `zk/evaluation/evaluate.py` imports
`backend/ml_inference.py` exactly the way `backend/app.py` already does
(`sys.path` + `import ml_inference` — `backend/` isn't a Python package,
so this is the established pattern, not a new one). The two halves talk
over the same plain-JSON files every other phase already uses
(`build/selection.json` in, `build/evaluation.json` out) — no new protocol
to explain.

## Integrity check before inference

Before a record's image is ever handed to the model,
`verify_image_integrity()` recomputes its SHA-256 and compares it to the
hash Phase 2's Merkle leaf for that record committed to. This is the same
content-hash property the Merkle tree already encodes — checking it again,
directly, right before inference means a record whose image file was
swapped out **after** the commitment was published is refused outright,
rather than being only theoretically catchable via a Merkle proof someone
would have to think to check.

## The synthetic demo dataset now has real images

Phase 2's demo dataset originally used SHA-256 hashes of short text
strings as placeholder `image_sha256` values (documented then as exactly
that — placeholders, not real image content). Phase 4 needs the model to
actually run on *something*, so `zk/evaluation/make_synthetic_images.py`
generates six small SYNTHETIC images (a gradient background with a bright
or dark rectangle — the same style as `ml_inference.py`'s own
`_make_synthetic_xray()` self-test image) under `zk/data/images/`, and
`zk/data/sample_dataset.json` was regenerated with their real SHA-256
digests (`dataset_version` bumped to `phase2-synthetic-demo-v2` to mark the
revision). The script is deterministic — re-running it reproduces
byte-identical files, so the committed hashes never drift. **This changed
the Merkle root** from Phase 2's original demo run — expected and correct,
not a bug: the dataset's content genuinely changed, so the commitment
correctly changed with it.

`ground_truth` labels are assigned by hand in that same file — synthetic
placeholders with no clinical basis, exactly like the images. Every place
`correct_predictions` is reported says so.

## ⚠ What this phase does and does not demonstrate

Read this before quoting any accuracy number this phase produces.

- **Real:** a real ONNX Runtime session, running the real, trained
  torchxrayvision `densenet121-res224-all` model, produces real, deterministic
  outputs, which get compared and counted exactly the way real evaluation data
  would be. The plumbing — selection → integrity check → inference →
  comparison → aggregation — is genuine end to end.
- **Not real:** the `ground_truth` labels being compared against are
  synthetic placeholders assigned by hand. `backend/ml_inference.py` now
  wraps a real trained model (torchxrayvision's `densenet121-res224-all`,
  see `CLAUDE.md`), so `correct_predictions / total_predictions` from this
  pipeline still is **not a medically meaningful accuracy figure** — but
  now only because the synthetic images and hand-assigned ground truth
  aren't real diagnoses, not because the model itself is untrained.

## Setup (one-time)

`MedicalDiagnosticsModel` exports `backend/models/densenet121_xrv.onnx` on
first use by downloading torchxrayvision's pretrained `densenet121-res224-all`
weights. This has been confirmed working on this machine (network access to
that model's host is not blocked here, unlike the sandbox this ZK layer was
originally built in).

```bash
# one-time, only if backend/models/densenet121_xrv.onnx doesn't exist yet:
pip install -r ../backend/requirements.txt
pip install torchxrayvision
python backend/ml_inference.py     # exports the model, runs the self-test
```

Once the model file exists, everything below runs with no network at all.

## Try it

```bash
cd zk
node merkle/commitDataset.mjs data/sample_dataset.json    # Phase 2
node sampling/selectFromCommitment.mjs 3                  # Phase 3
python evaluation/evaluate.py                              # Phase 4
```

Writes `build/evaluation.json` and prints a per-record breakdown
(prediction vs. ground truth) plus the `correct_predictions` /
`total_predictions` totals — with the synthetic-data warning printed
directly above them, every run.

## Tests

`zk/evaluation/test_evaluate.py` (Python's built-in `unittest`, no extra
test dependency — mirroring the "nothing beyond the runtime" approach the
JS tests take with `node:test`):

- `score_prediction` / `aggregate`: matching/non-matching/mixed/empty cases
- `verify_image_integrity`: accepts a matching file, **rejects a file whose
  content was swapped out from under a stored hash** (the core "a silently
  changed record is caught" property), rejects a wrong hash outright
- `load_dataset_by_record_id`: indexes correctly, rejects duplicate
  `record_id`s
- a real end-to-end integration test that runs the actual model — this one
  **skips itself** (not a failure) when `onnxruntime` isn't installed or the
  model file (`ml_inference.MODEL_PATH`) hasn't been exported yet, so the
  rest of the suite stays runnable without the heavier setup above

Run with `python -m unittest zk/evaluation/test_evaluate.py -v` from the
repo root.

---

# Phase 5 — Accuracy ZK Circuit

## The statement being proven

`circuits/accuracy.circom` proves:

```
correct_predictions * 100 >= threshold * total_predictions
```

i.e. "accuracy >= threshold%". This is a **threshold** proof, not an
equality proof — the task brief is explicit that proving
`correct * 100 == claimed_accuracy * total` would be the wrong shape,
since equality only proves one exact accuracy figure, not "at least X%".

## Public vs. private inputs

| Signal | Public? | Why |
|---|---|---|
| `total_predictions` | **Public** | Already public: it's Phase 3's `sample_size`, itself derived from the public Merkle root. If it were private here instead, a prover could claim `total_predictions = 1` and trivially satisfy any threshold — making the whole proof vacuous. |
| `threshold` | **Public** | It *is* the claim. A verifier who doesn't know what threshold was met can't check anything. |
| `correct_predictions` | **Private** | The one number this circuit exists to hide. Only its relationship to the (public) total and threshold is proven, not its value. |

**Documented limitation:** at small sample sizes, "private" narrows the
search space rather than hiding it — with `total_predictions = 3`, there
are only 4 possible values for `correct_predictions`. This is inherent to
proving a ratio over a small public denominator, not a flaw in the circuit
itself; it gets less significant as the evaluation sample grows (Phase 6+
territory).

## Enforced constraints

- `0 < total_predictions`
- `0 <= correct_predictions <= total_predictions`
- `0 <= threshold <= 100`
- `correct_predictions * 100 >= threshold * total_predictions`

All four are **hard constraints** — violating any of them means no witness
exists at all, not "a witness exists but the resulting proof fails
verification". A false accuracy claim cannot be proven, period.

## A circom footgun this circuit deliberately avoids

circomlib's `LessThan(n)` (and everything built on it — `LessEqThan`,
`GreaterThan`, `GreaterEqThan`) is only sound when both compared values are
already known to fit within `n` bits. It works by decomposing
`in[0] + 2^n - in[1]` into `n+1` bits; feed it an unconstrained value near
the field's modulus and that subtraction can wrap around and produce a
misleading result. Every value this circuit compares
(`correct_predictions`, `total_predictions`, `threshold`) is explicitly
range-checked with `Num2Bits(32)` **before** it ever reaches a comparator.
Skipping this step is a well-known class of circom bug, not a
hypothetical one — see `circuits/accuracy.circom`'s header comment for the
full reasoning.

## Try it

```bash
cd zk
npm run phase5
# or directly:
bash scripts/phase5_accuracy.sh
```

Compiles the circuit, runs Groth16 setup (reusing the same `pot12` ceremony
Phase 1 uses — 256 constraints comfortably fits a 2^12 setup), then:

1. proves and verifies a genuine 90%-accuracy claim against an 85% threshold
   (PASS)
2. attempts witness generation for four constraint-violating cases —
   accuracy below threshold, `correct > total`, `total = 0`, `threshold >
   100` — and confirms each one **fails to even produce a witness** (PASS)
3. tampers with a valid proof's public threshold after the fact, for parity
   with Phase 1's approach, and confirms verification rejects it (PASS)

## Tests

`test/accuracy.test.mjs` (same `node:test` + snarkjs-JS-API pattern as
`test/square.test.mjs`): a valid claim verifies with `correct_predictions`
absent from the public signals, tampering with the public threshold or the
proof itself is rejected, and each of the four constraint-violating cases
throws during witness generation. Run via `npm test` (needs
`bash scripts/phase5_accuracy.sh` run at least once first, to produce the
build artifacts).

---

# Phase 6 — Connecting Merkle + Sampling + ZK

Phase 6 is the wiring, not a new circuit: it takes Phase 4's real evaluation
output and turns it into a real Groth16 proof via Phase 5's already-existing
`circuits/accuracy.circom`, instead of the hand-typed example numbers
`scripts/phase5_accuracy.sh` uses to demonstrate the circuit in isolation.

```
build/commitment.json (Phase 2)
        |
        v
build/selection.json (Phase 3)
        |
        v
build/evaluation.json (Phase 4: correct_predictions / total_predictions from the REAL model)
        |
        v
witness/buildWitness.mjs --threshold N
        |
        v
build/accuracy_input.json = {"correct_predictions": N, "total_predictions": M, "threshold": T}
        |
        v
circuits/accuracy.circom  ->  Groth16 setup -> prove -> verify
```

## What's ZK-enforced vs. protocol-enforced

The brief requires this distinction be stated plainly, not implied.

| Property | Enforced by |
|---|---|
| `correct*100 >= threshold*total` arithmetic, and all four range checks | **the circuit** (`circuits/accuracy.circom`) — a real Groth16 / hard-constraint guarantee: a violating claim cannot even produce a witness |
| the image a prediction was made on matches what the Merkle leaf committed to | `evaluation/evaluate.py`'s `verify_image_integrity()` — ordinary code, not the circuit |
| sample selection can't be re-rolled for a favorable subset | `sampling/selectSamples.mjs`'s deterministic derivation from the published root — ordinary code, not the circuit |
| the evaluation set can't be silently altered after publishing its root | the Merkle tree itself (`merkle/merkleTree.mjs`) — cryptographic, but via hash commitment, not Groth16 |

Only the first row is a ZK-SNARK guarantee. Everything else is real, but is
"ordinary code checked a hash/determinism property," not "a proof system
verified it."

## `witness/`

- **`witnessBuilder.mjs`** — pure function `buildAccuracyWitness({correct,
  total, threshold})`, producing exactly `circuits/accuracy.circom`'s field
  names (`correct_predictions`, `total_predictions`, `threshold`) and
  public/private split. Validated and unit-tested independent of any file
  I/O or the circuit itself.
- **`buildWitness.mjs`** — CLI: `node witness/buildWitness.mjs --threshold N`
  reads `build/evaluation.json`, writes `build/accuracy_input.json`.
- **`scripts/phase6_pipeline.sh`** — runs the whole chain above in one
  command against a real evaluation run. Handles both real outcomes
  correctly: if the real result doesn't clear the threshold, witness
  generation is *expected* to fail (the circuit's hard-constraint
  guarantee), and the script reports that as a PASS, not an error — it only
  fails loudly if a witness generates without a corresponding pass, or a
  witness exists but proving/verification breaks.

## Try it

```bash
cd zk
THRESHOLD=50 bash scripts/phase6_pipeline.sh
```

Needs `backend/models/densenet121_xrv.onnx` exported first (see Phase 4's
setup) — this is the same real-model prerequisite Phase 4 already
documents, not a new one. Try a threshold your last real evaluation run's
accuracy clears (the script tells you what to try if it doesn't) to see the
positive, verifying path; the default 50% is deliberately likely to exceed
what a real pathology-detection model produces on the synthetic (non-X-ray)
demo images, precisely to exercise the "false claim correctly rejected"
path by default.

## Tests

`test/witness.test.mjs` (`node:test`, matching existing style): valid input
produces exactly the circuit's expected field names; rejects `total=0`,
negative `total`, `correct > total`, negative `correct`, `threshold`
outside `[0,100]`, and non-integer inputs; boundary cases accepted;
`meetsThreshold()` matches the circuit's intended inequality including the
exact-boundary case.

---

# Phase 8 — Security Layer

Phase 8 sits **around** the ZK proof, never inside it — see the layering
this section exists to preserve:

```
API security (backend/security.py)
      |
      v
request authentication / anti-replay
      |
      v
ZK proof generation
      |
      v
Groth16 proof
      |
      v
Groth16 verification
```

An API key proves "this caller is allowed to ask for a proof." It proves
nothing about model accuracy, and is never treated as if it did.
`validate_proof_request`'s range checks mirror what the circuit's
constraints also enforce, for the same "fail-fast convenience, not a
security boundary" reason `witnessBuilder.mjs`'s checks are — the circuit
is still the actual trust boundary for the accuracy claim.

## What's in `backend/security.py`

Scoped to `/generate_proof` only — `/predict` and `/health` are untouched.

- **API key** (`require_api_key`) — `X-API-Key` vs. `ZK_API_KEY` env var,
  `hmac.compare_digest`. Fails **closed**: an unconfigured `ZK_API_KEY`
  means the server refuses to run insecurely, not that it allows all
  requests through.
- **Rate limiting** (`enforce_rate_limit`, `RateLimiter`) — in-memory
  fixed-window, demo-scale (resets on restart, not multi-process-safe; a
  real deployment needs Redis or similar).
- **Input validation** (`validate_proof_request`) — see above.
- **HMAC tickets** (`issue_ticket` / `verify_ticket`) — a signed ticket
  carrying a nonce, `issued_at`/`expires_at`, and a **hash** of the request
  payload — never the payload itself, which is what keeps patient data out
  of tickets entirely. `verify_ticket` rejects expired tickets and replayed
  nonces (an in-memory seen-set for this session).
- **Secure temp files** (`secure_tempfile`) — `0600` permissions,
  guaranteed cleanup including on exception. Not used by `/predict` (which
  already handles its own temp file correctly) — ready for Phase 7's future
  witness/proof files.
- **Model integrity** (`verify_model_integrity`) — standalone SHA-256
  check utility, not wired into `ml_inference.py`.
- **Request IDs** — `uuid4()` per request, echoed as `X-Request-ID`.

`/generate_proof` gains all of the above plus a live `ticket` in its
response. Its body is still the Phase 4-era echo stub — Phase 7 replaces
the inner logic (with a real call into `circuits/accuracy.circom`'s
prove/verify, per Phase 6 above) without touching this gate again.

## Try it

```bash
export ZK_API_KEY=dev-demo-key-change-me
export ZK_TICKET_SECRET=dev-demo-secret-change-me
python backend/app.py
# in another shell:
curl -X POST localhost:8000/generate_proof \
  -H "Content-Type: application/json" -H "X-API-Key: dev-demo-key-change-me" \
  -d '{"claimed_accuracy": 80, "correct": 8, "total": 10}'
```

## Tests

`backend/test_security.py` (Python `unittest`, matching Phase 4's
approach): unit tests for every utility above (API key accept/reject, rate
limit trip + window reset, ticket issue/verify roundtrip, tampered ticket
rejected, expired ticket rejected, replayed nonce rejected, model-integrity
match/mismatch, `validate_proof_request` edge cases, `secure_tempfile`
cleanup including on exception — 30 tests), plus `fastapi.testclient`
integration tests against the real running route (6 tests: 401 without a
key, 200 with a valid key + valid body, 400 on an invalid body, 429 after
tripping the rate limit, `/health`/`/predict` unaffected). 36/36 passing.

Run with `python -m unittest backend/test_security.py -v` from the repo
root.

# Phase 7 — FastAPI Integration

Phase 7 is the last piece connecting the demo UI to real cryptography:
`/generate_proof` and `/verify_proof` now call the real toolchain, not a
stub. Preserves everything Phase 8 already built — same security gate,
same route shape, only what happens *inside* the route changed.

## Why a Python↔Node bridge

The ZK toolchain (circom, snarkjs) is Node/JS — that's where Phases 1–6
built and verified it. Rather than reimplementing any part of that in
Python, `backend/zk_proof.py` shells out to two small one-shot Node CLIs
that call snarkjs's JS API directly:

- **`zk/witness/proveAccuracy.mjs`** — stdin `{correct, total, threshold}`,
  stdout a real proof, or a clearly-typed error (see below). Requires the
  circuit already compiled and Groth16 setup already run — a real
  deployment's trusted setup happens **once, offline**, not per request;
  this script deliberately does not run it itself.
- **`zk/witness/verifyAccuracy.mjs`** — stdin `{proof, publicSignals}`,
  stdout `{"zk_verified": true|false}`. Always exits 0: "did not verify"
  (tampered proof, wrong signals, even malformed input) is a normal,
  expected outcome, not an error condition.

Both use the same `snarkjs.groth16.fullProve` / `snarkjs.groth16.verify`
JS-API pattern `test/accuracy.test.mjs` already exercises — no new
cryptographic code, just a new way of invoking the same, already-verified
path.

## `/generate_proof`, for real

```
authenticate + rate limit (Phase 8, unchanged)
        |
        v
validate_proof_request (Phase 8, unchanged)
        |
        v
generate_accuracy_proof(correct, total, threshold=claimed_accuracy)
        |
        v
  real Groth16 proof, or a typed refusal:
    - ClaimNotProvableError  -> HTTP 422 (the claim is false; no proof exists)
    - ZkToolchainNotReadyError -> HTTP 503 (one-time setup not run yet)
```

`claimed_accuracy` is treated as the circuit's `threshold` signal — "I
claim >= claimed_accuracy% accuracy." The existing request field name is
kept as-is (preserving the API, per the brief), just given its real
cryptographic meaning now that there's a real circuit to check it against.

**A false claim returns 422, not a fake proof and not a 500.** This
matters: the circuit's constraints mean witness generation itself fails
for a false claim (see Phase 5/6) — there is no proof to hand back, and
that refusal is the security property working, not a server error.

Response now carries `proof` (a real Groth16 proof: `pi_a`, `pi_b`,
`pi_c`, `protocol`, `curve`) and `public_signals` (`[valid,
total_predictions, threshold]` — `correct_predictions` never appears,
anywhere in the response), alongside the Phase 8 `request_id` and
`ticket`.

## `/verify_proof`, new

```json
POST /verify_proof
{"proof": {...}, "public_signals": ["1", "10", "70"]}
```

Same auth + rate limit as `/generate_proof`. **Deliberately not gated by
the `/generate_proof` ticket** — Groth16 verification is meant to be
re-checkable by anyone, any number of times (that is the entire point of
a public, portable proof). Nonce/replay protection belongs on the request
that *creates* a proof, not on checking one that already exists;
gating verification with one-time-use semantics would make proofs
useless for the auditing use case this whole project is for.

Always returns exactly `{"zk_verified": true}` or `{"zk_verified":
false}` — nothing else, and there is no code path that produces `true`
without the real `snarkjs.groth16.verify()` call agreeing. A tampered
proof, tampered public signals, or a well-formed proof checked against
the wrong claim's signals all correctly return `false`, not an error.

## Try it

```bash
export ZK_API_KEY=dev-demo-key-change-me
export ZK_TICKET_SECRET=dev-demo-secret-change-me
python backend/app.py
```

```bash
# generate a real proof
curl -s -X POST localhost:8000/generate_proof \
  -H "Content-Type: application/json" -H "X-API-Key: dev-demo-key-change-me" \
  -d '{"claimed_accuracy": 70, "correct": 8, "total": 10}' | tee /tmp/gp.json

# verify it for real
python3 -c "
import json, requests
r = json.load(open('/tmp/gp.json'))
resp = requests.post('http://localhost:8000/verify_proof',
    headers={'X-API-Key': 'dev-demo-key-change-me'},
    json={'proof': r['proof'], 'public_signals': r['public_signals']})
print(resp.json())   # {'zk_verified': True}
"
```

## Tests

- `backend/test_zk_proof.py` — the Python↔Node bridge directly, against
  the real toolchain (self-skips if the one-time setup hasn't run):
  valid claim produces a real proof (with `correct_predictions` absent
  from the public signals), the exact-boundary case (`70/100 >= 70%`)
  succeeds, false/out-of-range claims raise `ClaimNotProvableError`;
  verification of an honest proof succeeds, a tampered proof/public
  signal/malformed input all correctly return `False` without raising, a
  proof from one claim doesn't verify against a different claim's
  signals. 11 tests.
- `backend/test_security.py`'s `GenerateProofEndpointTests` /
  `VerifyProofEndpointTests` — the real routes end-to-end via
  `fastapi.testclient`: a valid claim gets a real proof back (protocol
  `groth16`, `correct_predictions` absent from the response), an
  unmeetable claim returns 422 with no proof in the body, `/verify_proof`
  round-trips an honest proof to `zk_verified: true` and a tampered
  proof/signal to `false`, both routes still require the API key. 41
  tests total in this file.

Run with `python -m unittest backend/test_zk_proof.py backend/test_security.py -v`
from the repo root (needs the one-time Groth16 setup run first — see Phase
5/6's "Try it" sections).

---

## Roadmap

| Phase | Status |
|---|---|
| 1. Toolchain sanity (`x*x=y`) | ✅ done |
| 2. Merkle dataset commitment | ✅ done |
| 3. Cryptographically bound sampling | ✅ done |
| 4. Evaluation pipeline | ✅ done, verified end-to-end against the real model (see Phase 4 setup) |
| 5. Accuracy circuit (`correct*100 >= threshold*total`) | ✅ done |
| 6. Merkle + sampling + ZK wiring | ✅ done, verified end-to-end against real evaluation output (both the correctly-rejected and correctly-verified cases) |
| 7. FastAPI `/generate_proof` + `/verify_proof` | ✅ done — real Groth16 proofs, real verification, both live in the running API |
| 8. Security layer | ✅ done, scoped to `/generate_proof` + `/verify_proof` |
| 9. Full test matrix | ✅ done — `PHASE9_TEST_MATRIX.md` maps every brief checklist item to its test; `bash run_all_tests.sh` runs all 120 in one command |
| 10. Documentation | not started |
