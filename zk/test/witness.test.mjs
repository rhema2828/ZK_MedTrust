/*
 * PHASE 6 WITNESS ASSEMBLY TESTS
 *
 * buildAccuracyWitness() produces the exact field names and public/private
 * split circuits/accuracy.circom (Phase 5) requires, and mirrors the same
 * range checks the circuit's constraints enforce - see witnessBuilder.mjs's
 * header for what that duplication is and is not a guarantee of.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAccuracyWitness, meetsThreshold, ACCURACY_SCALE } from "../witness/witnessBuilder.mjs";

test("valid input produces the circuit's exact expected field names", () => {
  const witness = buildAccuracyWitness({ correct: 8, total: 10, threshold: 70 });
  assert.deepEqual(witness, { correct_predictions: 8, total_predictions: 10, threshold: 70 });
});

test("rejects total = 0", () => {
  assert.throws(
    () => buildAccuracyWitness({ correct: 0, total: 0, threshold: 50 }),
    /total_predictions must be > 0/
  );
});

test("rejects negative total", () => {
  assert.throws(
    () => buildAccuracyWitness({ correct: 0, total: -1, threshold: 50 }),
    /total_predictions must be > 0/
  );
});

test("rejects correct > total", () => {
  assert.throws(
    () => buildAccuracyWitness({ correct: 11, total: 10, threshold: 50 }),
    /0 <= correct <= total/
  );
});

test("rejects negative correct", () => {
  assert.throws(
    () => buildAccuracyWitness({ correct: -1, total: 10, threshold: 50 }),
    /0 <= correct <= total/
  );
});

test("accepts correct = 0 and correct = total (boundary)", () => {
  assert.deepEqual(
    buildAccuracyWitness({ correct: 0, total: 5, threshold: 0 }),
    { correct_predictions: 0, total_predictions: 5, threshold: 0 }
  );
  assert.deepEqual(
    buildAccuracyWitness({ correct: 5, total: 5, threshold: 100 }),
    { correct_predictions: 5, total_predictions: 5, threshold: 100 }
  );
});

test("rejects threshold outside [0, 100]", () => {
  assert.throws(
    () => buildAccuracyWitness({ correct: 5, total: 10, threshold: 101 }),
    /threshold must satisfy/
  );
  assert.throws(
    () => buildAccuracyWitness({ correct: 5, total: 10, threshold: -1 }),
    /threshold must satisfy/
  );
});

test("rejects non-integer inputs", () => {
  assert.throws(() => buildAccuracyWitness({ correct: 5.5, total: 10, threshold: 50 }), /correct must be an integer/);
  assert.throws(() => buildAccuracyWitness({ correct: 5, total: 10.1, threshold: 50 }), /total must be an integer/);
  assert.throws(() => buildAccuracyWitness({ correct: 5, total: 10, threshold: 50.5 }), /threshold must be an integer/);
});

test("meetsThreshold matches the circuit's intended inequality", () => {
  assert.equal(meetsThreshold({ correct: 8, total: 10, threshold: 70 }), true);
  assert.equal(meetsThreshold({ correct: 8, total: 10, threshold: 90 }), false);
  assert.equal(meetsThreshold({ correct: 7, total: 10, threshold: 70 }), true); // exact boundary
});

test("ACCURACY_SCALE is 100, per the circuit", () => {
  assert.equal(ACCURACY_SCALE, 100);
});
