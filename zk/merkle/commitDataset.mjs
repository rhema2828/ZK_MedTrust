/*
 * PHASE 2 - build a dataset commitment.
 *
 * Reads a JSON array of evaluation records, canonicalizes and hashes each
 * one into a Merkle leaf, builds the tree, and writes out:
 *
 *   - build/commitment.json   the root + per-record leaf hashes (small,
 *                             this IS the public commitment a verifier is
 *                             given)
 *   - build/proofs.json       an inclusion proof for every record (this
 *                             file is a convenience for this demo/tests -
 *                             a real prover computes a proof only for the
 *                             specific indices Phase 3 selects, on demand,
 *                             rather than materializing every proof)
 *
 * Usable as a library (see exported `commitDataset`) or as a CLI:
 *   node merkle/commitDataset.mjs data/sample_dataset.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeRecord } from "./canonicalize.mjs";
import { stringToFieldElement } from "./poseidon.mjs";
import { MerkleTree } from "./merkleTree.mjs";

export async function commitDataset(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("dataset must be a non-empty array of records");
  }

  // Record order is significant and IS part of what the root commits to:
  // the same records in a different order produce a different root. This
  // is intentional (see README.md) - Phase 3's sampling indices are only
  // meaningful relative to one fixed, agreed ordering.
  const canonical = records.map(canonicalizeRecord);
  const leaves = canonical.map(stringToFieldElement);

  const tree = await MerkleTree.build(leaves);

  const commitment = {
    hash_function: "leaf = SHA256(canonical_record) mod BN254_r; node = Poseidon(left, right)",
    record_count: records.length,
    tree_depth: tree.depth,
    root: tree.root.toString(),
    records: records.map((r, i) => ({
      index: i,
      record_id: r.record_id,
      canonical: canonical[i],
      leaf: leaves[i].toString(),
    })),
  };

  const proofs = records.map((r, i) => {
    const { leaf, path } = tree.getProof(i);
    return {
      index: i,
      record_id: r.record_id,
      leaf: leaf.toString(),
      path: path.map((p) => ({ sibling: p.sibling.toString(), isRight: p.isRight })),
    };
  });

  return { tree, commitment, proofs };
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("usage: node merkle/commitDataset.mjs <dataset.json>");
    process.exit(1);
  }

  const zkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const records = JSON.parse(fs.readFileSync(inputPath, "utf8"));

  const { commitment, proofs } = await commitDataset(records);

  const buildDir = path.join(zkDir, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "commitment.json"), JSON.stringify(commitment, null, 2));
  fs.writeFileSync(path.join(buildDir, "proofs.json"), JSON.stringify(proofs, null, 2));

  console.log(`Committed ${commitment.record_count} records (tree depth ${commitment.tree_depth}).`);
  console.log(`Merkle root: ${commitment.root}`);
  console.log(`Wrote build/commitment.json and build/proofs.json`);
}

// Only run the CLI when this file is executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
