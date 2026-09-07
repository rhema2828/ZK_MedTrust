'use strict';
//
// Builds a depth-4 Poseidon Merkle tree (16 slots) over the 15 real cases
// in compliance_cases.sql — same structural pattern as
// ../scripts/build-tree.js's settlement tree, applied to compliance data:
//
//   leaf = Poseidon(caseIndex, salt, group1, group2)
//   group1 = Poseidon(bits[0..9])   -- criteria 1-10's pass/fail bits
//   group2 = Poseidon(bits[10..19]) -- criteria 11-20's pass/fail bits
//
// circomlib's Poseidon template supports at most 16 inputs per call
// (node_modules/circomlib/circuits/poseidon.circom's N_ROUNDS_P table has
// 16 entries), so the 20 criteria bits can't go into one Poseidon call —
// they're split into two groups of 10 and pre-hashed, then folded into the
// leaf alongside caseIndex and salt. Every one of the 20 bits still
// participates in the leaf: flipping any single bit changes its group
// hash, which changes the leaf.
//
// 15 real cases, not padded with fabricated ones — the one truly empty
// slot (16 - 15) holds the field element 0, the same padding convention
// ../scripts/build-tree.js uses for its unused slots.
//
// Each leaf is signed by a "compliance authority" EdDSA-Poseidon key —
// same trust model as the settlement tree's custodian signature: a case's
// claimed bit vector cannot produce a witness without the authority's
// actual signature over that exact leaf, so a prover cannot invent
// criteria results for a case the authority never attested to. Seeded
// independently from zk-attest's custodian key (different domain, so
// re-using the same key would conflate two unrelated attesters) and
// likewise overridable so this isn't forced to keep a hardcoded secret in
// source for anything beyond the demo.
const crypto = require('crypto');
const { buildPoseidon, buildEddsa } = require('circomlibjs');
const { allCases, caseById } = require('./db');
const { bitsFor, NUM_CRITERIA } = require('./criteria');

const DEPTH = 4;
const NUM_LEAVES = 1 << DEPTH; // 16
const GROUP_SIZE = NUM_CRITERIA / 2; // 10 + 10

const DEFAULT_AUTHORITY_KEY_SEED = 'zk-attest-demo-compliance-authority-eddsa-key-v1';
const AUTHORITY_KEY_SEED = process.env.COMPLIANCE_AUTHORITY_KEY_SEED || DEFAULT_AUTHORITY_KEY_SEED;

function isUsingDefaultAuthorityKey() {
  return AUTHORITY_KEY_SEED === DEFAULT_AUTHORITY_KEY_SEED;
}

let poseidonPromise = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

let eddsaPromise = null;
function getEddsa() {
  if (!eddsaPromise) eddsaPromise = buildEddsa();
  return eddsaPromise;
}

function fieldFromSeed(seed) {
  const digest = crypto.createHash('sha256').update(seed).digest();
  let x = 0n;
  for (const b of digest) x = (x << 8n) | BigInt(b);
  return x;
}

function authorityPrivateKeyBuffer() {
  return crypto.createHash('sha256').update(AUTHORITY_KEY_SEED).digest();
}

function saltFor(caseId) {
  return fieldFromSeed(`zk-attest-demo-compliance-salt:${caseId}`);
}

// "CASE-001" -> 1. The dataset's own numbering, not an arbitrary reindex —
// kept as a private witness value the same way settlement.circom keeps
// accountId private: it identifies which committed case a proof is about
// without that identity appearing in the proof's public signals.
function caseIndexOf(caseId) {
  const m = /^CASE-(\d+)$/.exec(caseId);
  if (!m) throw new Error(`Unrecognized case_id format: ${caseId}`);
  return Number(m[1]);
}

async function buildComplianceTree() {
  const poseidon = await getPoseidon();
  const eddsa = await getEddsa();
  const F = poseidon.F;

  const authorityPrv = authorityPrivateKeyBuffer();
  const authorityPub = eddsa.prv2pub(authorityPrv);
  const eddsaF = eddsa.F;

  const rows = allCases();
  const cases = rows.map((row) => {
    const bits = bitsFor(row);
    return {
      caseId: row.case_id,
      caseIndex: caseIndexOf(row.case_id),
      bits,
      salt: saltFor(row.case_id),
    };
  });

  const leaves = new Array(NUM_LEAVES).fill(0n);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];

    const group1 = poseidon(c.bits.slice(0, GROUP_SIZE).map(BigInt));
    const group2 = poseidon(c.bits.slice(GROUP_SIZE).map(BigInt));

    const leafHash = poseidon([BigInt(c.caseIndex), c.salt, F.toObject(group1), F.toObject(group2)]);
    leaves[i] = F.toObject(leafHash);

    const sig = eddsa.signPoseidon(authorityPrv, leafHash);
    c.attestation = {
      R8x: eddsaF.toObject(sig.R8[0]),
      R8y: eddsaF.toObject(sig.R8[1]),
      S: sig.S,
    };
    c.group1 = F.toObject(group1);
    c.group2 = F.toObject(group2);
    c.leafHash = leaves[i];
  }

  const levels = [leaves];
  for (let d = 0; d < DEPTH; d++) {
    const cur = levels[d];
    const next = new Array(cur.length / 2);
    for (let i = 0; i < next.length; i++) {
      const h = poseidon([cur[2 * i], cur[2 * i + 1]]);
      next[i] = F.toObject(h);
    }
    levels.push(next);
  }

  const root = levels[DEPTH][0];
  const authorityPubKey = { Ax: eddsaF.toObject(authorityPub[0]), Ay: eddsaF.toObject(authorityPub[1]) };

  return { poseidon, F, cases, levels, root, authorityPubKey };
}

function slotIndexOf(tree, caseId) {
  const idx = tree.cases.findIndex((c) => c.caseId === caseId);
  if (idx === -1) throw new Error(`case ${caseId} is not in the committed compliance tree`);
  return idx;
}

function pathFor(tree, slot) {
  const pathElements = [];
  const pathIndices = [];
  let idx = slot;
  for (let d = 0; d < DEPTH; d++) {
    const level = tree.levels[d];
    const isRightChild = idx % 2 === 1;
    const siblingIdx = isRightChild ? idx - 1 : idx + 1;
    pathElements.push(level[siblingIdx]);
    pathIndices.push(isRightChild ? 1 : 0);
    idx = Math.floor(idx / 2);
  }
  return { pathElements, pathIndices };
}

// Builds the exact circuit-input object for circuits/compliance.circom.
async function witnessFor(caseId, { passThreshold, proofNonce } = {}) {
  const tree = await buildComplianceTree();
  const slot = slotIndexOf(tree, caseId);
  const c = tree.cases[slot];
  const { pathElements, pathIndices } = pathFor(tree, slot);

  return {
    input: {
      caseIndex: String(c.caseIndex),
      bits: c.bits.map(String),
      salt: c.salt.toString(),
      attestationR8x: c.attestation.R8x.toString(),
      attestationR8y: c.attestation.R8y.toString(),
      attestationS: c.attestation.S.toString(),
      pathElements: pathElements.map(String),
      pathIndices: pathIndices.map(String),
      merkleRoot: tree.root.toString(),
      passThreshold: String(passThreshold),
      proofNonce: String(proofNonce),
      authorityPubKeyAx: tree.authorityPubKey.Ax.toString(),
      authorityPubKeyAy: tree.authorityPubKey.Ay.toString(),
    },
    tree,
    case: c,
  };
}

async function getComplianceRoot() {
  const tree = await buildComplianceTree();
  return tree.root.toString();
}

async function getAuthorityPubKey() {
  const tree = await buildComplianceTree();
  return { Ax: tree.authorityPubKey.Ax.toString(), Ay: tree.authorityPubKey.Ay.toString() };
}

// Demo-only transparency helper (see ../scripts/build-tree.js's
// explainWitness for the identical rationale): safe here because every
// one of these 15 cases' pass/fail statuses is already visible via
// GET /api/compliance/cases — this just additionally reveals the
// cryptographic construction (bits, salt, group hashes, leaf, signature,
// path) that the ZK proof otherwise keeps private.
async function explainComplianceWitness(caseId) {
  const tree = await buildComplianceTree();
  const slot = slotIndexOf(tree, caseId);
  const c = tree.cases[slot];
  const { pathElements, pathIndices } = pathFor(tree, slot);
  return {
    caseId: c.caseId,
    caseIndex: c.caseIndex,
    bits: c.bits,
    salt: c.salt.toString(),
    group1: c.group1.toString(),
    group2: c.group2.toString(),
    leafHash: c.leafHash.toString(),
    attestation: { R8x: c.attestation.R8x.toString(), R8y: c.attestation.R8y.toString(), S: c.attestation.S.toString() },
    pathElements: pathElements.map(String),
    pathIndices,
    merkleRoot: tree.root.toString(),
    authorityPubKey: { Ax: tree.authorityPubKey.Ax.toString(), Ay: tree.authorityPubKey.Ay.toString() },
  };
}

module.exports = {
  DEPTH,
  NUM_LEAVES,
  buildComplianceTree,
  witnessFor,
  getComplianceRoot,
  getAuthorityPubKey,
  explainComplianceWitness,
  slotIndexOf,
  pathFor,
  caseIndexOf,
  isUsingDefaultAuthorityKey,
};
