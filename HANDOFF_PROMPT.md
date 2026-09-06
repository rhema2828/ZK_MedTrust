# ZK_MedTrust — session handoff (Phases 1–4 done, continuing on a new machine)

Paste everything below this line as your first message to the new Claude Code
session, after putting `zk-medtrust-phases-1-4.bundle` somewhere on that
machine (e.g. your Downloads folder) and telling Claude the path to it.

---

## Why you're getting this instead of a normal repo checkout

Work on this task was done in a sandboxed remote session whose GitHub access
was denied at the organization level (`Claude doesn't have GitHub access to
rhema2828/ZK_MedTrust for your organization` — a 403 from GitHub itself, not
a bug), so 5 commits on branch `claude/zk-medtrust-layer-tgpnhs` were built
and verified locally but could **never be pushed**. They also can't be
`git fetch`ed from GitHub for the same reason — the branch doesn't exist on
the remote at all yet. So instead of a URL, you have a **git bundle** file:
`zk-medtrust-phases-1-4.bundle`, containing the complete branch history
(7 commits total, full repo from the initial commit).

The other thing that sandbox couldn't do: `download.pytorch.org` (pretrained
ImageNet ResNet-18 weights) was also 403'd by its egress policy, so Phase 4's
live model run never completed — that failure is expected and is not a bug
either. **This is presumably the whole reason you're on a normal laptop now.**

## Step 0 — load the bundle and get the branch

```bash
git clone https://github.com/rhema2828/ZK_MedTrust
cd ZK_MedTrust
git bundle verify /path/to/zk-medtrust-phases-1-4.bundle
git fetch /path/to/zk-medtrust-phases-1-4.bundle claude/zk-medtrust-layer-tgpnhs:claude/zk-medtrust-layer-tgpnhs
git checkout claude/zk-medtrust-layer-tgpnhs
git log --oneline   # should show 7 commits, top one "Document the zk/ layer (Phases 1-4) in CLAUDE.md"
```

Push it immediately so the branch exists remotely and nothing gets lost
again:

```bash
git push -u origin claude/zk-medtrust-layer-tgpnhs
```

If a PR doesn't already exist for this branch, open one (draft is fine).

## Step 1 — read these two files before doing anything else

- **`CLAUDE.md`** — has a "Zero-Knowledge Layer (`zk/`)" section summarizing
  exactly what Phases 1–4 built and how.
- **`zk/README.md`** — the full technical detail per phase: algorithms,
  exact commands, what's public vs. private, documented limitations.

Do not re-derive or redo Phases 1–3 (Circom/SnarkJS toolchain, Merkle
commitment, bound sampling) — they're done, tested (36/36 JS tests pass),
and committed. Phase 4's *code* is done and unit-tested (12/13 Python tests
pass; the 13th self-skips, see below) — only its live run against the real
model is pending, because of the network block above.

## Step 2 — finish Phase 4 for real (the actual reason for this handoff)

**Critical instruction: use the existing `backend/ml_inference.py` exactly
as it already is. Do NOT modify it, and do NOT substitute a randomly
initialized backbone (`weights=None` or similar) as a workaround for
anything.** The whole point of moving to this machine is that
`download.pytorch.org` should be reachable here, so
`MedicalDiagnosticsModel`'s normal, already-written code path — real
ImageNet-pretrained ResNet-18 weights via torchvision, with the existing
seeded (seed=42) random 2-class head on top — should Just Work. If it
doesn't reach `download.pytorch.org` from this machine either, STOP and
say so rather than working around it; do not fake the export.

```bash
# one-time setup
pip install -r backend/requirements.txt
pip install torch torchvision        # not in requirements.txt on purpose, see CLAUDE.md

# this must succeed and actually download real pretrained weights this time
python backend/ml_inference.py
# expect: a self-test prediction printed as JSON, and backend/models/resnet18.onnx now exists

# zk/ toolchain (circom + snarkjs) - same install path as the sandbox used
cd zk
bash scripts/install_toolchain.sh
bash scripts/ptau.sh
bash scripts/phase1_square.sh        # confirms nothing broke in transit
node merkle/commitDataset.mjs data/sample_dataset.json
node sampling/selectFromCommitment.mjs 3
python evaluation/evaluate.py        # THE step that was blocked - run it for real now
npm test                              # should be 36/36
cd ..
python -m unittest zk/evaluation/test_evaluate.py -v   # should now be 13/13, none skipped
```

If `evaluate.py` runs successfully, you now have a genuine end-to-end
Phases 1–4 result. Commit `build/evaluation.json`'s content isn't tracked
(it's gitignored, generated) — nothing to commit for this step unless you
want to note in a commit message that the live run was confirmed.

## Step 3 — continue with Phase 5 onward

Below is the **original, complete task brief** exactly as given, covering
Phases 1–10 and the strict rules governing the whole project. Phases 1–4 are
already done per above; resume at **Phase 5 — Accuracy ZK Circuit**, and
continue phase by phase, running tests after each one, per rule 11/12 below.

> We are now building the Zero-Knowledge layer of this project.
>
> Repository:
> ZK_MedTrust
>
> IMPORTANT CONTEXT
>
> This project already has backend work implemented by another developer ("Rudy"), including:
>
> - FastAPI backend
> - ONNX Runtime inference
> - ResNet-18 based inference wrapper
> - Streamlit frontend
> - cybersecurity/API hardening work may already exist locally
>
> DO NOT rebuild or replace existing functionality.
>
> Your job is to add the REAL Zero-Knowledge Proof layer on top of the existing architecture.
>
> Before changing ANYTHING, inspect the repository thoroughly.
>
> ==================================================
> STEP 0 — UNDERSTAND WHAT ALREADY EXISTS
> ==================================================
>
> Inspect:
>
> - backend/app.py
> - backend/ml_inference.py
> - backend/requirements.txt
> - frontend/streamlit_app.py
> - README/readme.md
> - CLAUDE.md
> - tests/
> - all existing security-related files
> - git status
> - recent git history
>
> Determine:
>
> 1. What functionality already exists.
> 2. What /predict currently does.
> 3. What /generate_proof currently does.
> 4. Whether /verify_proof exists.
> 5. What security features already exist.
> 6. What files you intend to modify.
> 7. What files you intend to create.
>
> Do NOT modify anything during this inspection.
>
> ==================================================
> PROJECT ZK GOAL
> ==================================================
>
> The eventual system should allow a hospital/local evaluator to prove:
>
> "The diagnostic model achieved at least X% accuracy on an evaluation dataset"
>
> without revealing:
>
> - individual patient images
> - individual patient records
> - individual prediction results
> - the complete evaluation dataset
>
> The high-level architecture is:
>
> Evaluation Dataset
>         ↓
> Canonicalize records
>         ↓
> Hash each record
>         ↓
> Merkle Tree
>         ↓
> Merkle Root Commitment
>         ↓
> Cryptographically bound sample selection
>         ↓
> Run existing ML model
>         ↓
> Compare predictions with ground truth
>         ↓
> correct_predictions / total_predictions
>         ↓
> ZK-SNARK
>         ↓
> Groth16 Proof
>         ↓
> Verifier
>         ↓
> zk_verified = true
>
> The Merkle commitment and sampling mechanism are intended to prevent a prover from simply cherry-picking favorable examples.
>
> ==================================================
> VERY IMPORTANT MODEL LIMITATION
> ==================================================
>
> Inspect backend/ml_inference.py carefully.
>
> The current ResNet-18 implementation uses an ImageNet-pretrained backbone but the final Normal/Abnormal classification head is randomly initialized.
>
> Therefore:
>
> DO NOT claim that the current model has meaningful clinical accuracy.
>
> DO NOT claim that the ZK system proves medical correctness.
>
> The ZK system proves a mathematical statement about supplied evaluation results.
>
> Keep these concepts separate:
>
> 1. ML inference
> 2. Model evaluation
> 3. Cryptographic proof
>
> ==================================================
> TECHNOLOGY
> ==================================================
>
> Use:
>
> - Circom
> - SnarkJS
> - Groth16
> - BN128 / BN254
>
> Do NOT implement a fake Python "ZK proof".
>
> Do NOT replace a real cryptographic proof with hashing.
>
> Do NOT return zk_verified=true without actual Groth16 verification.
>
> Do NOT use HMAC as a replacement for the ZK proof.
>
> ==================================================
> DEVELOPMENT STRATEGY
> ==================================================
>
> Build this incrementally.
>
> DO NOT attempt the complete system in one shot.
>
> We will work through the following phases.
>
> --------------------------------------------------
> PHASE 1 — ZK TOOLCHAIN SANITY TEST
> --------------------------------------------------
>
> First create a minimal Circom circuit proving:
>
> x * x = y
>
> Example:
>
> private input:
> x
>
> public input:
> y
>
> The prover knows x.
>
> The verifier only learns y.
>
> Create a clean structure such as:
>
> zk/
> ├── circuits/
> ├── build/
> ├── scripts/
> ├── package.json
> └── README.md
>
> Use Circom + SnarkJS + Groth16.
>
> Actually:
>
> 1. Compile the Circom circuit.
> 2. Generate the witness.
> 3. Perform the Groth16 setup.
> 4. Generate a real proof.
> 5. Generate public signals.
> 6. Verify the proof with SnarkJS.
> 7. Modify the public input.
> 8. Demonstrate that verification fails.
>
> This is NOT optional.
>
> If Circom or SnarkJS is unavailable, STOP and tell me exactly what is missing.
>
> Do not create a fake substitute.
>
> After Phase 1 succeeds, STOP.
>
> Report:
>
> - files created
> - files modified
> - commands executed
> - proof generation result
> - verification result
> - negative verification result
>
> Wait before continuing.
>
> --------------------------------------------------
> PHASE 2 — MERKLE DATASET COMMITMENT
> --------------------------------------------------
>
> After Phase 1 is confirmed working, build the dataset commitment subsystem.
>
> For each evaluation record:
>
> record
>   ↓
> canonical representation
>   ↓
> cryptographic hash
>
> Build a Merkle tree from those hashes.
>
> Produce:
>
> - leaf hashes
> - Merkle root
> - inclusion proofs
>
> Implement verification of inclusion proofs.
>
> Document exactly:
>
> - what is included in each leaf
> - how records are canonicalized
> - what hash function is used
> - how the Merkle root commits to the dataset
>
> The same dataset must always produce the same root.
>
> The commitment must prevent silently changing an evaluation record after commitment.
>
> --------------------------------------------------
> PHASE 3 — CRYPTOGRAPHICALLY BOUND SAMPLING
> --------------------------------------------------
>
> Implement sample selection that is bound to the dataset commitment.
>
> Do NOT simply use:
>
> random.sample(dataset)
>
> where the prover can repeatedly rerun the process until they get favorable samples.
>
> The selection must be deterministic/reproducible from cryptographic material associated with the commitment.
>
> Document the exact algorithm.
>
> The goal is:
>
> dataset
> → Merkle root
> → sampling seed
> → selected indices
>
> The verifier must be able to determine that the selected samples correspond to the committed dataset.
>
> --------------------------------------------------
> PHASE 4 — EVALUATION PIPELINE
> --------------------------------------------------
>
> Use the existing MedicalDiagnosticsModel.
>
> For each selected evaluation record:
>
> image
> +
> ground_truth
> ↓
> existing model.predict()
> ↓
> prediction
> ↓
> compare prediction with ground_truth
> ↓
> correct = 0 or 1
>
> Calculate:
>
> correct_predictions
> total_predictions
>
> Do NOT modify the existing ML inference system unnecessarily.
>
> Do NOT fabricate evaluation results.
>
> For the current hackathon demo, synthetic evaluation data is acceptable, but clearly label it as synthetic.
>
> --------------------------------------------------
> PHASE 5 — ACCURACY ZK CIRCUIT
> --------------------------------------------------
>
> Build the real Circom circuit for the accuracy claim.
>
> The mathematical statement is:
>
> correct_predictions * SCALE >= threshold * total_predictions
>
> Use:
>
> SCALE = 100
>
> This represents percentage accuracy.
>
> The circuit must enforce:
>
> 0 < total_predictions
>
> 0 <= correct_predictions <= total_predictions
>
> 0 <= threshold <= SCALE
>
> Use integer arithmetic only.
>
> No floating point.
>
> The circuit must NOT simply prove an equality like:
>
> correct * 100 == claimed_accuracy * total
>
> because that does not prove a threshold unless the relationship is constructed correctly.
>
> Clearly document:
>
> PUBLIC INPUTS
>
> PRIVATE INPUTS
>
> The minimum information exposed to the verifier should be public.
>
> The individual evaluation results should remain private where possible.
>
> --------------------------------------------------
> PHASE 6 — CONNECT MERKLE + SAMPLING + ZK
> --------------------------------------------------
>
> Connect the systems:
>
> Dataset
>  ↓
> Merkle root
>  ↓
> Cryptographically bound sample selection
>  ↓
> Evaluation
>  ↓
> correct/total
>  ↓
> ZK witness
>  ↓
> Groth16 proof
>  ↓
> verification
>
> The prover should be able to demonstrate the accuracy claim without exposing the underlying evaluation records.
>
> Be explicit about which parts are actually enforced inside the ZK circuit and which parts are enforced by the surrounding protocol.
>
> Do NOT claim that something is ZK-protected if it is only checked by ordinary application code.
>
> --------------------------------------------------
> PHASE 7 — FASTAPI INTEGRATION
> --------------------------------------------------
>
> Only after the cryptographic components work independently.
>
> Integrate with the existing FastAPI backend.
>
> Preserve the existing API and security architecture wherever possible.
>
> Implement a real:
>
> POST /generate_proof
>
> and:
>
> POST /verify_proof
>
> /generate_proof must:
>
> 1. authenticate the request using the existing security layer
> 2. validate inputs
> 3. construct/use the evaluation commitment
> 4. generate the witness
> 5. invoke SnarkJS
> 6. generate a real Groth16 proof
> 7. return the proof and required public signals
>
> /verify_proof must:
>
> 1. validate the proof structure
> 2. validate public signals
> 3. invoke the real SnarkJS verifier
> 4. return:
>
> {
>   "zk_verified": true
> }
>
> ONLY if verification actually succeeds.
>
> Otherwise:
>
> {
>   "zk_verified": false
> }
>
> There must be NO shortcut that can produce true without cryptographic verification.
>
> --------------------------------------------------
> PHASE 8 — SECURITY INTEGRATION
> --------------------------------------------------
>
> Preserve the existing security layer.
>
> API key authentication,
> rate limiting,
> input validation,
> temporary-file security,
> request IDs,
> HMAC tickets,
> nonce/TTL replay protection,
> and model integrity
>
> are API/security mechanisms.
>
> They are NOT substitutes for the ZK proof.
>
> Maintain this separation:
>
> API security
>       ↓
> request authentication / anti-replay
>       ↓
> ZK proof generation
>       ↓
> Groth16 proof
>       ↓
> Groth16 verification
>
> Do not put patient data inside HMAC tickets.
>
> --------------------------------------------------
> PHASE 9 — TESTS
> --------------------------------------------------
>
> Add tests for:
>
> ZK sanity:
>
> - valid x²=y proof succeeds
> - modified public input fails
> - modified proof fails
>
> Accuracy circuit:
>
> - valid threshold succeeds
> - accuracy below threshold fails
> - correct_predictions > total_predictions fails
> - total_predictions = 0 fails
> - invalid threshold fails
>
> Merkle:
>
> - valid inclusion proof succeeds
> - modified leaf fails
> - modified root fails
> - modified record fails
>
> Protocol:
>
> - malformed proof rejected
> - replayed proof/ticket rejected
> - expired ticket rejected
>
> API:
>
> - /generate_proof produces a real proof
> - /verify_proof actually verifies it
> - invalid proof returns zk_verified=false
>
> --------------------------------------------------
> PHASE 10 — DOCUMENTATION
> --------------------------------------------------
>
> Update the README with a simple explanation.
>
> Explain:
>
> What are we proving?
>
> What remains private?
>
> What is public?
>
> What is the Merkle root?
>
> Why do we need dataset commitment?
>
> How is sampling performed?
>
> What does Groth16 prove?
>
> How do we generate a proof?
>
> How do we verify a proof?
>
> What does the current ML model NOT prove?
>
> Include exact setup and execution commands.
>
> ==================================================
> STRICT RULES
> ==================================================
>
> 1. Do not rebuild existing backend functionality.
> 2. Do not remove existing security features.
> 3. Do not push to GitHub.
> 4. Local commits are allowed only if useful.
> 5. Never fake cryptographic verification.
> 6. Never hardcode proof outputs.
> 7. Never hardcode 950/1000 or similar evaluation statistics into production code.
> 8. Do not claim clinical validity.
> 9. Do not expose patient data in logs.
> 10. Do not put patient data into API tickets.
> 11. Do not proceed to the next phase until the current phase works.
> 12. Run tests after every phase.
> 13. Keep the implementation understandable enough for a first-semester developer to explain during a hackathon.

## Amendments to the strict rules, made explicitly by the project owner during Phases 1–4

- **Rule 3 ("do not push to GitHub") was explicitly lifted.** The owner said:
  *"create a new branch and commit onto that or do whatever you think works
  best to add this layer onto the repo and yes commit it now and after that
  go ahead with phase 2"* — push and open a (draft) PR for
  `claude/zk-medtrust-layer-tgpnhs` once it's up.
- **Trusted setup:** the Powers-of-Tau ceremony is a **local development
  ceremony**, not a real multi-party trusted setup (the real Hermez file was
  unreachable in the sandbox). This is fine to keep as-is for the demo, but
  keep the loud "not a trusted setup" warnings in place — don't silently
  upgrade the claim. If you want a real ceremony file now that you have
  normal internet, that's a nice-to-have, not a requirement.
- **Security layer (Phase 8):** the owner said *"build both security work
  and zk layer i want everything done"* — Phase 8 is real implementation
  work (API key + rate limit + input validation + HMAC tickets + nonce/TTL,
  scoped to the new ZK endpoints), not documentation-only, since the repo
  had no security layer to preserve in the first place.
- **This handoff itself:** triggered because the sandbox could reach neither
  GitHub (push) nor `download.pytorch.org` (pretrained weights). Once both
  work here, there's no reason to keep working around anything — proceed
  exactly per the rules above, including rule 3 as amended (push).

## Known/expected non-issues, so you don't re-diagnose them

- `npm audit` in `zk/` reports 3 high-severity advisories in `underscore`
  (transitive via `snarkjs → bfj → jsonpath`). No upstream fix exists that
  doesn't break snarkjs; the affected code path isn't reachable from how
  `zk/` calls snarkjs. Documented in `zk/README.md`, left as-is deliberately.
- The Merkle root changed once already, intentionally, between Phase 2 and
  Phase 4 (placeholder text-hash images → real synthetic image files,
  `dataset_version` bumped `v1` → `v2`). If you see a root that doesn't match
  something from early in this conversation's history, that's why.
- `frontend/streamlit_app.py:104`'s "Verify Proof" button is a known fake —
  it sets a session flag on click with no real check. Leave it broken until
  Phase 10 (or whenever you wire the frontend to a real `/verify_proof`) —
  don't fix it early out of order.

## Straight after loading this context

Run `git log --oneline -7` and `cat zk/README.md`'s roadmap table to
reconfirm status, then proceed with **Phase 5**.
