/*
 * PHASE 2 MERKLE TESTS
 *
 * Covers exactly the cases the project brief calls out:
 *   - valid inclusion proof succeeds
 *   - modified leaf fails
 *   - modified root fails
 *   - modified record fails (tampering with a SOURCE record, before
 *     hashing, is caught the same way - because it changes the leaf)
 * plus the property the whole subsystem exists for:
 *   - the same dataset always produces the same root (determinism)
 *   - changing any one record anywhere changes the root
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeRecord } from "../merkle/canonicalize.mjs";
import { stringToFieldElement } from "../merkle/poseidon.mjs";
import { MerkleTree, verifyInclusionProof } from "../merkle/merkleTree.mjs";
import { commitDataset } from "../merkle/commitDataset.mjs";

const ZK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ZK_DIR, "data", "sample_dataset.json"), "utf8"));

function record(overrides = {}) {
  return {
    record_id: "R1",
    image_sha256: "a".repeat(64),
    ground_truth: "Normal",
    dataset_version: "test-v1",
    ...overrides,
  };
}

// ---------------------------------------------------------------- canonicalize
test("canonicalize: same record always yields the same string", () => {
  const a = canonicalizeRecord(record());
  const b = canonicalizeRecord(record());
  assert.equal(a, b);
});

test("canonicalize: field order in the input object does not matter", () => {
  const r1 = { record_id: "R1", image_sha256: "b".repeat(64), ground_truth: "Abnormal", dataset_version: "v1" };
  const r2 = { dataset_version: "v1", ground_truth: "Abnormal", record_id: "R1", image_sha256: "b".repeat(64) };
  assert.equal(canonicalizeRecord(r1), canonicalizeRecord(r2));
});

test("canonicalize: rejects a missing field", () => {
  const bad = record();
  delete bad.dataset_version;
  assert.throws(() => canonicalizeRecord(bad));
});

test("canonicalize: rejects an unrecognised ground_truth", () => {
  assert.throws(() => canonicalizeRecord(record({ ground_truth: "Cancerous" })));
});

test("canonicalize: rejects a malformed image_sha256", () => {
  assert.throws(() => canonicalizeRecord(record({ image_sha256: "not-a-hash" })));
});

test("canonicalize: different ground_truth changes the canonical string", () => {
  const normal = canonicalizeRecord(record({ ground_truth: "Normal" }));
  const abnormal = canonicalizeRecord(record({ ground_truth: "Abnormal" }));
  assert.notEqual(normal, abnormal);
});

// ---------------------------------------------------------------- Merkle tree
test("Merkle: same dataset always produces the same root", async () => {
  const { commitment: c1 } = await commitDataset(SAMPLE);
  const { commitment: c2 } = await commitDataset(SAMPLE);
  assert.equal(c1.root, c2.root);
});

test("Merkle: changing one record anywhere changes the root", async () => {
  const { commitment: original } = await commitDataset(SAMPLE);

  const mutated = SAMPLE.map((r) => ({ ...r }));
  mutated[3] = { ...mutated[3], ground_truth: mutated[3].ground_truth === "Normal" ? "Abnormal" : "Normal" };
  const { commitment: changed } = await commitDataset(mutated);

  assert.notEqual(original.root, changed.root);
});

test("Merkle: reordering the same records changes the root", async () => {
  const { commitment: original } = await commitDataset(SAMPLE);
  const reordered = [...SAMPLE].reverse();
  const { commitment: changed } = await commitDataset(reordered);
  assert.notEqual(original.root, changed.root);
});

test("Merkle: a valid inclusion proof verifies against the real root", async () => {
  const { tree, commitment } = await commitDataset(SAMPLE);
  const { leaf, path } = tree.getProof(2);
  const ok = await verifyInclusionProof(leaf, path, BigInt(commitment.root));
  assert.equal(ok, true);
});

test("Merkle: every record in the dataset has a valid inclusion proof", async () => {
  const { tree, commitment } = await commitDataset(SAMPLE);
  for (let i = 0; i < SAMPLE.length; i++) {
    const { leaf, path } = tree.getProof(i);
    assert.equal(await verifyInclusionProof(leaf, path, BigInt(commitment.root)), true, `record ${i}`);
  }
});

test("Merkle: a modified leaf value fails to verify", async () => {
  const { tree, commitment } = await commitDataset(SAMPLE);
  const { path } = tree.getProof(2);
  const tamperedLeaf = tree.getProof(2).leaf + 1n;
  const ok = await verifyInclusionProof(tamperedLeaf, path, BigInt(commitment.root));
  assert.equal(ok, false);
});

test("Merkle: a modified root fails to verify a genuine proof", async () => {
  const { tree, commitment } = await commitDataset(SAMPLE);
  const { leaf, path } = tree.getProof(2);
  const tamperedRoot = BigInt(commitment.root) + 1n;
  const ok = await verifyInclusionProof(leaf, path, tamperedRoot);
  assert.equal(ok, false);
});

test("Merkle: a proof from one dataset does not verify against another dataset's root", async () => {
  const { tree } = await commitDataset(SAMPLE);
  const mutated = SAMPLE.map((r) => ({ ...r }));
  mutated[0] = { ...mutated[0], ground_truth: "Abnormal" };
  const { commitment: otherCommitment } = await commitDataset(mutated);

  const { leaf, path } = tree.getProof(0);
  const ok = await verifyInclusionProof(leaf, path, BigInt(otherCommitment.root));
  assert.equal(ok, false);
});

test("Merkle: a tampered SOURCE record (before hashing) is caught by the leaf it produces", async () => {
  // This is "modified record fails" - simulate someone editing a record
  // post-commitment and re-submitting an inclusion proof for it.
  const { tree: originalTree } = await commitDataset(SAMPLE);
  const genuineProof = originalTree.getProof(1);

  const editedRecord = { ...SAMPLE[1], ground_truth: SAMPLE[1].ground_truth === "Normal" ? "Abnormal" : "Normal" };
  const editedLeaf = stringToFieldElement(canonicalizeRecord(editedRecord));

  assert.notEqual(editedLeaf, genuineProof.leaf);

  // The edited record's own leaf does not verify against the ORIGINAL root.
  const { commitment } = await commitDataset(SAMPLE);
  const ok = await verifyInclusionProof(editedLeaf, genuineProof.path, BigInt(commitment.root));
  assert.equal(ok, false);
});

test("Merkle: rejects an empty dataset", async () => {
  await assert.rejects(() => commitDataset([]));
});

test("Merkle: a single-record dataset has a root and a trivial valid proof", async () => {
  const one = [SAMPLE[0]];
  const { tree, commitment } = await commitDataset(one);
  assert.equal(commitment.tree_depth, 0);
  const { leaf, path } = tree.getProof(0);
  assert.equal(path.length, 0);
  assert.equal(await verifyInclusionProof(leaf, path, BigInt(commitment.root)), true);
});
