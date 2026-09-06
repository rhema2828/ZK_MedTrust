/*
 * PHASE 6 - witness assembly for the REAL accuracy circuit.
 *
 * circuits/accuracy.circom (Phase 5) proves:
 *
 *     correct_predictions * 100 >= threshold * total_predictions
 *
 * Signal names and public/private split come directly from that circuit -
 * see its header comment for the full rationale:
 *
 *   correct_predictions  - PRIVATE
 *   total_predictions    - PUBLIC (already public via Phase 3's sample_size;
 *                           making it private would let a prover claim
 *                           total_predictions=1 to trivially clear any bar)
 *   threshold             - PUBLIC (it IS the claim being verified)
 *
 * buildAccuracyWitness() also enforces the same four checks the circuit's
 * constraints enforce (0 < total, 0 <= correct <= total, 0 <= threshold <=
 * 100, and optionally the threshold inequality itself via meetsThreshold).
 * IMPORTANT: this is a fail-fast guardrail for the honest path, not a
 * security boundary - it runs as ordinary JS, so a prover who controls
 * their own machine can bypass it trivially. The circuit's constraints are
 * what actually make these bounds trustless: witness generation for a
 * violating input doesn't just get rejected later, it cannot happen at
 * all (see circuits/accuracy.circom and scripts/phase5_accuracy.sh).
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

  // Exact field names circuits/accuracy.circom's generated witness
  // calculator expects - see zk/scripts/phase5_accuracy.sh's make_input().
  return {
    correct_predictions: correct,
    total_predictions: total,
    threshold,
  };
}

/** Does (correct, total, threshold) satisfy the claim - the same integer
 * arithmetic the circuit checks? Useful to warn a prover *before* they
 * spend a witness-generation attempt on a claim the circuit will refuse
 * to even produce a witness for. Still not a security boundary itself. */
export function meetsThreshold({ correct, total, threshold }) {
  return correct * SCALE >= threshold * total;
}

export const ACCURACY_SCALE = SCALE;
