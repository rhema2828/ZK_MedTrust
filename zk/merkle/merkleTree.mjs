/*
 * PHASE 2 - the Merkle tree itself.
 *
 * A Merkle tree lets a single 32-ish-byte number (the "root") commit to an
 * entire ordered list of records: change any single record, anywhere in the
 * list, and the root changes. That is the whole security property this
 * subsystem exists to provide - see commitDataset.mjs and the Phase 2
 * section of README.md for how it plugs into the rest of the project.
 *
 * Binary tree, Poseidon(left, right) combines two children into their
 * parent. Leaves are already-reduced BN254 field elements (see poseidon.mjs)
 * - not the raw records, not the raw SHA-256 digests.
 *
 * PADDING: the tree must have a power-of-two number of leaves to be a
 * regular binary tree. Real leaves are ~254-bit numbers derived from
 * SHA-256, so they are, for all practical purposes, never exactly 0.
 * Padding slots are filled with the field element 0n, which:
 *   - can be told apart from any real leaf by a verifier who is handed the
 *     leaf list (0 is a value no genuine record can hash to for practical
 *     purposes - the chance a real SHA-256(record) mod p happens to be 0
 *     is about 1 in 2^254), and
 *   - is documented here rather than silently duplicating the last real
 *     leaf, which is a known way to make two *different* datasets collide
 *     on the same root (a duplicated last leaf can be produced by more
 *     than one input list).
 */

import { poseidon2 } from "./poseidon.mjs";

const PAD_LEAF = 0n;

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class MerkleTree {
  /** @param {bigint[]} leaves - already-hashed, already-reduced leaf values, in dataset order. */
  constructor(leaves, levels) {
    if (leaves.length === 0) {
      throw new Error("cannot build a Merkle tree over zero records");
    }
    this.leafCount = leaves.length;   // real leaves, before padding
    this.levels = levels;             // levels[0] = padded leaves, ..., levels[top] = [root]
  }

  static async build(leaves) {
    if (leaves.length === 0) {
      throw new Error("cannot build a Merkle tree over zero records");
    }

    const size = nextPowerOfTwo(leaves.length);
    const padded = leaves.slice();
    while (padded.length < size) padded.push(PAD_LEAF);

    const levels = [padded];
    let current = padded;
    while (current.length > 1) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(await poseidon2(current[i], current[i + 1]));
      }
      levels.push(next);
      current = next;
    }

    return new MerkleTree(leaves, levels);
  }

  get root() {
    return this.levels[this.levels.length - 1][0];
  }

  get depth() {
    return this.levels.length - 1;
  }

  /**
   * Inclusion proof for the record at `index` (0-based, in original dataset
   * order - the same order the record was passed to MerkleTree.build in).
   *
   * Returns { leaf, path } where path is an array, one entry per tree
   * level, of { sibling, isRight }. isRight = true means the node being
   * proved (at that level) is the RIGHT child, i.e. the parent is
   * Poseidon(sibling, node); isRight = false means the parent is
   * Poseidon(node, sibling).
   */
  getProof(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.leafCount) {
      throw new RangeError(`index ${index} is out of range for ${this.leafCount} records`);
    }

    const path = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const nodes = this.levels[level];
      const isRight = i % 2 === 1;
      const siblingIndex = isRight ? i - 1 : i + 1;
      path.push({ sibling: nodes[siblingIndex], isRight });
      i = Math.floor(i / 2);
    }

    return { leaf: this.levels[0][index], path };
  }
}

/**
 * Standalone inclusion-proof verification - deliberately does NOT touch a
 * MerkleTree instance. This is the function a verifier who only has
 * (leaf, proof, claimed root) - and NOT the rest of the dataset - runs to
 * decide whether the leaf really is part of the committed dataset.
 */
export async function verifyInclusionProof(leaf, path, root) {
  let node = BigInt(leaf);
  for (const { sibling, isRight } of path) {
    node = isRight
      ? await poseidon2(sibling, node)
      : await poseidon2(node, sibling);
  }
  return node === BigInt(root);
}
