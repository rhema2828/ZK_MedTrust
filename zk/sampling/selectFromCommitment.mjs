/*
 * PHASE 3 - CLI: select samples for an already-built commitment.
 *
 * Reads build/commitment.json (produced by Phase 2's commitDataset.mjs)
 * and build/proofs.json, applies selectSamples(), and writes
 * build/selection.json - the list a verifier can independently recompute
 * and compare against, plus (for convenience, same rationale as
 * proofs.json in Phase 2) the specific inclusion proofs for just the
 * selected records.
 *
 *   node sampling/selectFromCommitment.mjs <sample_size>
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectSamples, deriveSeed } from "./selectSamples.mjs";

async function main() {
  const sampleSizeArg = process.argv[2];
  if (!sampleSizeArg) {
    console.error("usage: node sampling/selectFromCommitment.mjs <sample_size>");
    process.exit(1);
  }
  const sampleSize = Number(sampleSizeArg);

  const zkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const buildDir = path.join(zkDir, "build");
  const commitmentPath = path.join(buildDir, "commitment.json");
  const proofsPath = path.join(buildDir, "proofs.json");

  if (!fs.existsSync(commitmentPath)) {
    console.error(`Missing ${commitmentPath} - run merkle/commitDataset.mjs first.`);
    process.exit(1);
  }

  const commitment = JSON.parse(fs.readFileSync(commitmentPath, "utf8"));
  const proofs = JSON.parse(fs.readFileSync(proofsPath, "utf8"));

  // dataset_version is not stored on the commitment itself (Phase 2's
  // commitment.json is version-agnostic across possibly-mixed-version
  // datasets), so it is read off the records - all records in one
  // commitment are expected to share one dataset_version. We re-derive it
  // here from the canonical strings rather than trusting a separate field.
  const versions = new Set(
    commitment.records.map((r) => r.canonical.split("|")[3])
  );
  if (versions.size !== 1) {
    console.error(`Expected exactly one dataset_version across the commitment, found: ${[...versions]}`);
    process.exit(1);
  }
  const datasetVersion = [...versions][0];

  const indices = selectSamples(commitment.root, datasetVersion, commitment.record_count, sampleSize);

  const selection = {
    root: commitment.root,
    dataset_version: datasetVersion,
    record_count: commitment.record_count,
    sample_size: sampleSize,
    seed: deriveSeed(commitment.root, datasetVersion, sampleSize),
    indices,
    selected_records: indices.map((i) => ({
      index: i,
      record_id: commitment.records[i].record_id,
      leaf: commitment.records[i].leaf,
      inclusion_proof: proofs[i].path,
    })),
  };

  fs.writeFileSync(path.join(buildDir, "selection.json"), JSON.stringify(selection, null, 2));

  console.log(`Selected ${sampleSize} of ${commitment.record_count} records for root ${commitment.root}`);
  console.log(`Indices: [${indices.join(", ")}]`);
  console.log(`Record IDs: [${selection.selected_records.map((r) => r.record_id).join(", ")}]`);
  console.log(`Wrote build/selection.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
