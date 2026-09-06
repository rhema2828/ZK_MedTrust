/*
 * PHASE 3 - cryptographically bound sample selection.
 *
 * The problem this solves: if a hospital could just call something like
 * random.sample(dataset, k) themselves, they could re-roll it as many
 * times as they like, privately, until they land on a subset of records
 * their model happens to get right, and only THEN generate a proof over
 * that subset. The proof would be completely genuine and completely
 * meaningless.
 *
 * The fix is to make the sample a DETERMINISTIC function of the Merkle
 * root (Phase 2) and a couple of already-public parameters, rather than a
 * fresh coin flip. Once a hospital has published a root, the samples that
 * will be evaluated are already fixed - there is no "try again" step,
 * because trying again means presenting a different root, which is a
 * publicly visible, different commitment to a (potentially different)
 * dataset.
 *
 *   dataset  --(Phase 2)-->  root  --(this file)-->  seed  -->  indices
 *
 * ALGORITHM (deliberately simple, so it stays explainable):
 *
 *   1. seed = SHA256(`${root}|${dataset_version}|${sample_size}`)
 *      All three inputs are PUBLIC - the same three numbers/strings a
 *      verifier already has from the commitment. This is the only
 *      "randomness" in the whole scheme, and it is not randomness at all:
 *      it is a fixed hash of fixed public values.
 *
 *   2. Expand the seed into a sequence of candidate indices with a
 *      counter: for i = 0, 1, 2, ...
 *        candidate = SHA256(`${seed}:${i}`) mod record_count
 *      Keep the first `sample_size` DISTINCT candidates (skip repeats).
 *      This is "sampling without replacement" implemented as rejection
 *      of duplicates - simple to read, and correct.
 *
 *      (The `mod record_count` step is very slightly biased towards small
 *      indices in general, because 2^256 is not usually a multiple of
 *      record_count. For any dataset size a human would actually use, that
 *      bias is smaller than 2^-250 - astronomically below anything that
 *      matters here, so no extra rejection-sampling correction is applied.)
 *
 *   3. Return the selected indices sorted ascending. Sorting only affects
 *      presentation - it is the SET of indices that matters, not the
 *      order they were discovered in.
 *
 * A VERIFIER runs exactly the same two steps from the same three public
 * values and checks the result matches what the prover claims to have
 * evaluated. See verifySelection() below.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST (documented honestly, not swept
 * under the rug): a curator who controls what "the dataset" even is could
 * still try constructing several different-but-superficially-legitimate
 * datasets and only publish the root of whichever one happens to produce
 * a favorable sample. Binding the sample to the root stops re-rolling
 * samples FOR A FIXED, ALREADY-PUBLISHED dataset; it does not by itself
 * stop someone from shopping around for a different dataset before ever
 * publishing anything. Closing that gap needs an unpredictable input the
 * curator does not control (e.g. a public randomness beacon, or an
 * independent auditor's nonce) mixed into the seed - noted here as future
 * work, not implemented, so as not to overstate what this file provides.
 */

import { createHash } from "node:crypto";

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** The seed a sample selection is derived from - public inputs only. */
export function deriveSeed(root, datasetVersion, sampleSize) {
  return sha256Hex(`${root}|${datasetVersion}|${sampleSize}`);
}

/**
 * Deterministically selects `sampleSize` distinct indices from
 * [0, recordCount) given the dataset's Merkle root and version.
 * Returns a plain array of numbers, sorted ascending.
 */
export function selectSamples(root, datasetVersion, recordCount, sampleSize) {
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new Error(`recordCount must be a positive integer, got ${recordCount}`);
  }
  if (!Number.isInteger(sampleSize) || sampleSize <= 0 || sampleSize > recordCount) {
    throw new Error(
      `sampleSize must be an integer in [1, recordCount=${recordCount}], got ${sampleSize}`
    );
  }

  const seed = deriveSeed(root, datasetVersion, sampleSize);
  const recordCountBig = BigInt(recordCount);

  const selected = new Set();
  let counter = 0;
  // Bounded so a bug can never spin forever; correct inputs converge in
  // O(recordCount * log(recordCount)) iterations in expectation.
  const maxIterations = recordCount * 200 + 10000;

  while (selected.size < sampleSize) {
    if (counter > maxIterations) {
      throw new Error("selectSamples: exceeded max iterations - this should not happen for valid inputs");
    }
    const digest = sha256Hex(`${seed}:${counter}`);
    const candidate = Number(BigInt("0x" + digest) % recordCountBig);
    selected.add(candidate);
    counter++;
  }

  return [...selected].sort((a, b) => a - b);
}

/**
 * What a verifier runs: recompute the selection independently from public
 * values and check it matches what the prover claims to have used.
 * `claimedIndices` may be in any order - only the SET is compared.
 */
export function verifySelection(root, datasetVersion, recordCount, sampleSize, claimedIndices) {
  let expected;
  try {
    expected = selectSamples(root, datasetVersion, recordCount, sampleSize);
  } catch {
    return false;
  }

  if (!Array.isArray(claimedIndices) || claimedIndices.length !== expected.length) {
    return false;
  }
  const claimedSorted = [...claimedIndices].sort((a, b) => a - b);
  return expected.every((v, i) => v === claimedSorted[i]);
}
