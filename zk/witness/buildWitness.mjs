/*
 * PHASE 6 - CLI: build the accuracy circuit's witness input from Phase 4's
 * evaluation output.
 *
 * Reads build/evaluation.json (produced by evaluation/evaluate.py) and a
 * --threshold argument, and writes build/accuracy_input.json - the exact
 * shape a Circom witness generator for the accuracy circuit will consume
 * once that circuit exists (see witnessBuilder.mjs's header comment).
 *
 *   node witness/buildWitness.mjs --threshold 80
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAccuracyWitness, meetsThreshold } from "./witnessBuilder.mjs";

function parseThresholdArg(argv) {
  const flagIndex = argv.indexOf("--threshold");
  if (flagIndex === -1 || argv[flagIndex + 1] === undefined) {
    console.error("usage: node witness/buildWitness.mjs --threshold <0-100>");
    process.exit(1);
  }
  const value = Number(argv[flagIndex + 1]);
  if (!Number.isInteger(value)) {
    console.error(`--threshold must be an integer, got ${JSON.stringify(argv[flagIndex + 1])}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const threshold = parseThresholdArg(process.argv.slice(2));

  const zkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const buildDir = path.join(zkDir, "build");
  const evaluationPath = path.join(buildDir, "evaluation.json");

  if (!fs.existsSync(evaluationPath)) {
    console.error(
      `Missing ${evaluationPath} - run evaluation/evaluate.py first (needs Phases 2-4's ` +
      `commitDataset.mjs, selectFromCommitment.mjs, and evaluate.py to have run).`
    );
    process.exit(1);
  }

  const evaluation = JSON.parse(fs.readFileSync(evaluationPath, "utf8"));

  let witness;
  try {
    witness = buildAccuracyWitness({
      correct: evaluation.correct_predictions,
      total: evaluation.total_predictions,
      threshold,
    });
  } catch (err) {
    console.error(`Refusing to build a witness: ${err.message}`);
    process.exit(1);
  }

  const outPath = path.join(buildDir, "accuracy_input.json");
  fs.writeFileSync(outPath, JSON.stringify(witness, null, 2) + "\n");

  console.log(`correct=${witness.correct} total=${witness.total} threshold=${witness.threshold}`);
  console.log(
    meetsThreshold(witness)
      ? `This witness DOES satisfy the claim (>=${threshold}%) - a real proof, once the circuit exists, should verify.`
      : `This witness does NOT satisfy the claim (>=${threshold}%) - a real proof, once the circuit exists, should FAIL to be produced/verify.`
  );
  console.log(`Wrote ${outPath}`);
  console.log(
    `Reminder: ground truth and the underlying model are ${
      evaluation.synthetic_data_warning ? "SYNTHETIC/placeholder" : "unlabeled"
    } - see evaluation.json's own warning field.`
  );
}

main();
