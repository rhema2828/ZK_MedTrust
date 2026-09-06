/*
 * PHASE 6 - witness assembly (scaffolding, not the accuracy circuit itself).
 *
 * Phase 5's circuit (built separately - see zk/README.md's Phase 6 section
 * for current status) will prove:
 *
 *     correct_predictions * 100 >= threshold * total_predictions
 *
 * with `correct`/`total` PRIVATE and `threshold` PUBLIC. That signal shape
 * is already fully specified by the project brief, so this module builds
 * exactly the witness input a circuit with that shape expects, from Phase
 * 4's evaluation output - independent of whether the circuit file has
 * landed in this checkout yet.
 *
 * buildAccuracyWitness() also enforces the same three range checks the
 * circuit itself will enforce (0 < total, 0 <= correct <= total,
 * 0 <= threshold <= 100). IMPORTANT: this is a fail-fast guardrail for the
 * honest path, not a security boundary - it runs as ordinary JS, so a
 * prover who controls their own machine can bypass it trivially. The
 * circuit's constraints are what actually make these bounds trustless once
 * it exists. See zk/README.md.
 */

const SCALE = 100;

export function buildAccuracyWitness({ correct, total, threshold }) {
  if (!Number.isInteger(correct)) {
    throw new Error(`correct must be an integer, got ${JSON.stringify(correct)}`);
  }
  if (!Number.isInteger(total)) {
    throw new Error(`total must be an integer, got ${JSON.stringify(total)}`);
  }
  if (!Number.isInteger(threshold)) {
    throw new Error(`threshold must be an integer, got ${JSON.stringify(threshold)}`);
  }

  if (total <= 0) {
    throw new Error(`total_predictions must be > 0, got ${total}`);
  }
  if (correct < 0 || correct > total) {
    throw new Error(
      `correct_predictions must satisfy 0 <= correct <= total, got correct=${correct} total=${total}`
    );
  }
  if (threshold < 0 || threshold > SCALE) {
    throw new Error(`threshold must satisfy 0 <= threshold <= ${SCALE}, got ${threshold}`);
  }

  return { correct, total, threshold };
}

/** Convenience: does this (correct, total, threshold) satisfy the claim,
 * the same integer arithmetic the circuit will check? Useful for a CLI to
 * warn a prover *before* they burn a Groth16 setup on a witness that could
 * never satisfy the circuit's constraints - still not itself a security
 * boundary, same caveat as above. */
export function meetsThreshold({ correct, total, threshold }) {
  return correct * SCALE >= threshold * total;
}

export const ACCURACY_SCALE = SCALE;
