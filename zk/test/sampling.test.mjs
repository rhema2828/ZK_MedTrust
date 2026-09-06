/*
 * PHASE 3 SAMPLING TESTS
 *
 * The property this whole subsystem exists for: given a fixed committed
 * root, the sample is fixed too - not re-rollable, and independently
 * recomputable by anyone who only has the public commitment values.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { selectSamples, verifySelection, deriveSeed } from "../sampling/selectSamples.mjs";

const ROOT_A = "17269475279474181943853964134342870699231731156363264120696208918728336604008";
const ROOT_B = "1234567890123456789012345678901234567890123456789012345678901234567890";
const VERSION = "phase2-synthetic-demo-v1";

test("sampling: deterministic - same inputs always yield the same indices", () => {
  const a = selectSamples(ROOT_A, VERSION, 6, 3);
  const b = selectSamples(ROOT_A, VERSION, 6, 3);
  assert.deepEqual(a, b);
});

test("sampling: a different root (almost always) yields a different sample", () => {
  const a = selectSamples(ROOT_A, VERSION, 6, 3);
  const b = selectSamples(ROOT_B, VERSION, 6, 3);
  assert.notDeepEqual(a, b);
});

test("sampling: a different dataset_version yields a different sample", () => {
  const a = selectSamples(ROOT_A, VERSION, 6, 3);
  const b = selectSamples(ROOT_A, "some-other-version", 6, 3);
  assert.notDeepEqual(a, b);
});

test("sampling: indices are unique, in range, and the requested count", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 4);
  assert.equal(indices.length, 4);
  assert.equal(new Set(indices).size, 4, "no duplicate indices");
  for (const i of indices) {
    assert.ok(Number.isInteger(i) && i >= 0 && i < 6, `index ${i} out of range`);
  }
});

test("sampling: sample_size == record_count selects every index", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 6);
  assert.deepEqual(indices, [0, 1, 2, 3, 4, 5]);
});

test("sampling: rejects sample_size of 0", () => {
  assert.throws(() => selectSamples(ROOT_A, VERSION, 6, 0));
});

test("sampling: rejects sample_size greater than record_count", () => {
  assert.throws(() => selectSamples(ROOT_A, VERSION, 6, 7));
});

test("sampling: rejects a non-positive record_count", () => {
  assert.throws(() => selectSamples(ROOT_A, VERSION, 0, 1));
});

test("sampling: seed is a pure function of the three public inputs", () => {
  assert.equal(deriveSeed(ROOT_A, VERSION, 3), deriveSeed(ROOT_A, VERSION, 3));
  assert.notEqual(deriveSeed(ROOT_A, VERSION, 3), deriveSeed(ROOT_A, VERSION, 4));
});

// ---------------------------------------------------------- verifySelection
test("verifySelection: accepts the genuine selection", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 3);
  assert.equal(verifySelection(ROOT_A, VERSION, 6, 3, indices), true);
});

test("verifySelection: is order-independent (only the set matters)", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 3);
  const shuffled = [...indices].reverse();
  assert.equal(verifySelection(ROOT_A, VERSION, 6, 3, shuffled), true);
});

test("verifySelection: rejects a selection with one index swapped out", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 3);
  const notInSelection = [0, 1, 2, 3, 4, 5].find((i) => !indices.includes(i));
  const tampered = [...indices.slice(1), notInSelection];
  assert.equal(verifySelection(ROOT_A, VERSION, 6, 3, tampered), false);
});

test("verifySelection: rejects a selection claimed against the wrong root", () => {
  const indicesForA = selectSamples(ROOT_A, VERSION, 6, 3);
  assert.equal(verifySelection(ROOT_B, VERSION, 6, 3, indicesForA), false);
});

test("verifySelection: rejects a selection of the wrong length", () => {
  const indices = selectSamples(ROOT_A, VERSION, 6, 3);
  assert.equal(verifySelection(ROOT_A, VERSION, 6, 3, indices.slice(0, 2)), false);
});

test("sampling: a prover cannot 're-roll' - there is no hidden randomness to vary for a fixed root/version/size", () => {
  // Calling selectSamples 50 times with identical public inputs must
  // produce identical output every time - there is nothing to re-roll.
  const runs = new Set();
  for (let i = 0; i < 50; i++) {
    runs.add(JSON.stringify(selectSamples(ROOT_A, VERSION, 6, 3)));
  }
  assert.equal(runs.size, 1);
});
