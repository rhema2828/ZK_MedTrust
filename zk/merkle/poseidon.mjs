/*
 * PHASE 2 - hashing primitives.
 *
 * Two different hashes are used, deliberately, for two different jobs:
 *
 *   SHA-256   turns an arbitrary-length canonical record string into a
 *             fixed-size digest. Cheap, standard, nothing ZK-specific
 *             about it - this step never runs inside a circuit.
 *
 *   Poseidon  combines two field elements into one, for the Merkle tree
 *             itself. Poseidon is used (instead of, say, SHA-256 again)
 *             because it is "SNARK-friendly": it costs a handful of
 *             constraints per hash inside a circom circuit, where SHA-256
 *             costs thousands. Phase 6 will need to re-verify a Merkle
 *             path *inside* a circuit, so the tree has to be built with a
 *             hash that will still be cheap when that day comes. We use
 *             circomlibjs's Poseidon here specifically because it is the
 *             same implementation (same round constants, same field) as
 *             circomlib's Poseidon() circom template - so a tree built in
 *             JS here and a path checked in a circuit later will agree.
 *
 * A SHA-256 digest is 256 bits, but Poseidon operates on elements of the
 * BN254 scalar field, which is slightly smaller than 256 bits (~254 bits).
 * So every SHA-256 output is reduced mod the field prime before it is used
 * as a Poseidon input. This loses a negligible ~2 bits of the digest -
 * irrelevant for collision resistance at this scale - and is what lets the
 * same number be used later as a circuit signal.
 */

import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";

// BN254 (a.k.a. alt_bn128) scalar field prime - the field Groth16 over this
// curve, and every circom circuit compiled for it, operates in.
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

let poseidonPromise = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

/** SHA-256 of a UTF-8 string, reduced into the BN254 scalar field. */
export function stringToFieldElement(str) {
  const digest = createHash("sha256").update(str, "utf8").digest("hex");
  return BigInt("0x" + digest) % FIELD_PRIME;
}

/** Poseidon-hash two field elements into one (used for Merkle tree nodes). */
export async function poseidon2(a, b) {
  const poseidon = await getPoseidon();
  const result = poseidon([BigInt(a), BigInt(b)]);
  return BigInt(poseidon.F.toString(result));
}
