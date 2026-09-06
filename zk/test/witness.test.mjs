/*
 * PHASE 6 WITNESS ASSEMBLY TESTS
 *
 * buildAccuracyWitness() mirrors the exact range checks the (not-yet-built)
 * accuracy circuit will also enforce - see witnessBuilder.mjs's header for
 * why that duplication is deliberate and what it is / is not a guarantee of.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildAccuracyWitness, meetsThreshold, ACCURACY_SCALE } from "../witness/witnessBuilder.mjs";

test("valid input passes through unchanged", () => {
  const witness = buildAccuracyWitness({ correct: 8, total: 10, threshold: 70 });
  assert.deepEqual(witness, { correct: 8, total: 10, threshold: 70 });
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
  assert.deepEqual(buildAccuracyWitness({ correct: 0, total: 5, threshold: 0 }), { correct: 0, total: 5, threshold: 0 });
  assert.deepEqual(buildAccuracyWitness({ correct: 5, total: 5, threshold: 100 }), { correct: 5, total: 5, threshold: 100 });
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
  // 8/10 = 80% >= 70% threshold
  assert.equal(meetsThreshold({ correct: 8, total: 10, threshold: 70 }), true);
  // 8/10 = 80% < 90% threshold
  assert.equal(meetsThreshold({ correct: 8, total: 10, threshold: 90 }), false);
  // exact boundary: 7/10 = 70% >= 70%
  assert.equal(meetsThreshold({ correct: 7, total: 10, threshold: 70 }), true);
});

test("ACCURACY_SCALE is 100, per the brief", () => {
  assert.equal(ACCURACY_SCALE, 100);
});
