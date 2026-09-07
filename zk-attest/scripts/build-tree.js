'use strict';
//
// The custodian's internal book, modelled as a depth-8 Poseidon Merkle tree
// (256 slots — unused slots hold the field element 0, matching what the
// frozen circuit's MerklePath(8) expects).
//
// Leaf = Poseidon(accountId, balance, salt, blocked). The salt is per-account
// and deterministic — derived from a fixed demo seed via SHA-256, reduced
// into the BN254 scalar field — so the root reproduces identically on every
// laptop without persisting anything. It doesn't need to be secret for this
// demo: what's private is *which* leaf a given proof used, not the salt
// formula.
//
// `blocked` is a custodian-set flag (0 or 1) folded into the leaf itself —
// the circuit enforces `blocked === 0`, so a proof cannot be constructed at
// all for a flagged account. One demo account (1005) is hardcoded blocked so
// this is backed by a real leaf and a real failing constraint, not narration.
//
// Every leaf is also signed by a custodian EdDSA-Poseidon (Baby Jubjub) key:
// signature = signPoseidon(custodianPrivateKey, leafHash). The circuit
// verifies this signature in-circuit against a public custodian key, so a
// balance/block-status claim with no matching signature cannot produce a
// witness at all — the leaf is trusted because the custodian actually
// attested to it, not merely because this script wrote it into the tree.
// The custodian private key seed defaults to a fixed demo string (same
// reproducibility rationale as the salts below), but is overridable via the
// CUSTODIAN_KEY_SEED env var — so a real deployment isn't forced to keep a
// hardcoded secret baked into source. Overriding it does not by itself make
// this "production ready": whatever holds the real value still needs real
// custody (HSM/KMS/etc.), and the demo's own deterministic reproducibility
// is lost once you do. isUsingDefaultCustodianKey() exists so callers (the
// server, at boot) can surface that loudly rather than silently.
const crypto = require('crypto');
const { buildPoseidon, buildEddsa } = require('circomlibjs');

const DEPTH = 8;
const NUM_LEAVES = 1 << DEPTH; // 256

const DEFAULT_CUSTODIAN_PRIVATE_KEY_SEED = 'zk-attest-demo-custodian-eddsa-key-v1';
const CUSTODIAN_PRIVATE_KEY_SEED = process.env.CUSTODIAN_KEY_SEED || DEFAULT_CUSTODIAN_PRIVATE_KEY_SEED;

function isUsingDefaultCustodianKey() {
  return CUSTODIAN_PRIVATE_KEY_SEED === DEFAULT_CUSTODIAN_PRIVATE_KEY_SEED;
}

// Institution book. `role` is demo narration only — never enters the circuit.
// `blocked` DOES enter the circuit (folded into the leaf) — it is a real
// constraint input, not a display-only label.
const BOOK = [
  { accountId: 1001, balance: 12500000, blocked: 0, name: 'Meridian Capital Partners', role: 'our client — clears the $1M bar comfortably' },
  { accountId: 1002, balance: 4300000, blocked: 0, name: 'Northfield Treasury Group', role: 'another honest institution' },
  { accountId: 1003, balance: 250000, blocked: 0, name: 'Ashcombe Reserve Fund', role: 'below threshold — the tamper case' },
  { accountId: 1004, balance: 88000000, blocked: 0, name: 'Corvatta Institutional Holdings', role: 'large institution, widens the anonymity set' },
  { accountId: 1005, balance: 9800000, blocked: 1, name: 'Halcyon Trade Corp', role: 'sanctioned — clears the balance bar but is custodian-flagged blocked' },
];

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
  return x; // reduced mod field prime by poseidon.F.e() at hash time
}

// The custodian's EdDSA private key: 32 raw bytes, demo-deterministic via
// SHA-256 of a fixed seed string. `signPoseidon`/`prv2pub` internally derive
// the actual signing scalar from this buffer via blake512 + standard EdDSA
// clamping — this is just the 32-byte seed they expect, not the scalar
// itself.
function custodianPrivateKeyBuffer() {
  return crypto.createHash('sha256').update(CUSTODIAN_PRIVATE_KEY_SEED).digest();
}

// Deterministic per-account salt: SHA-256("zk-attest-demo-salt:<accountId>").
function saltFor(accountId) {
  return fieldFromSeed(`zk-attest-demo-salt:${accountId}`);
}

async function buildTree() {
  const poseidon = await getPoseidon();
  const eddsa = await getEddsa();
  const F = poseidon.F;

  const custodianPrv = custodianPrivateKeyBuffer();
  const custodianPub = eddsa.prv2pub(custodianPrv); // [Ax, Ay] in babyJub.F representation
  const eddsaF = eddsa.F; // babyJub's own field object — used for all Ax/Ay/R8x/R8y conversions below

  const accounts = BOOK.map((entry) => ({ ...entry, salt: saltFor(entry.accountId) }));

  // Leaves, in fixed slot order (slot i = accounts[i], remaining slots = 0).
  // Each leaf is also signed by the custodian key — signPoseidon's message
  // argument must already be a field element in the same representation
  // Poseidon just produced it in, which it is (both use the BN254 base
  // field), so the raw Poseidon output is passed straight through as `msg`.
  const leaves = new Array(NUM_LEAVES).fill(0n);
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const leafHash = poseidon([BigInt(a.accountId), BigInt(a.balance), a.salt, BigInt(a.blocked)]);
    leaves[i] = F.toObject(leafHash);
    const sig = eddsa.signPoseidon(custodianPrv, leafHash);
    a.attestation = {
      R8x: eddsaF.toObject(sig.R8[0]),
      R8y: eddsaF.toObject(sig.R8[1]),
      S: sig.S,
    };
  }

  // levels[0] = leaves, levels[DEPTH] = [root]
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

  const custodianPubKey = {
    Ax: eddsaF.toObject(custodianPub[0]),
    Ay: eddsaF.toObject(custodianPub[1]),
  };

  return { poseidon, F, accounts, levels, root, custodianPubKey };
}

function slotIndexOf(tree, accountId) {
  const idx = tree.accounts.findIndex((a) => a.accountId === accountId);
  if (idx === -1) {
    throw new Error(`account ${accountId} is not in the custodian's book`);
  }
  return idx;
}

// Sibling path for leaf index `slot`: pathElements[d] is the sibling node at
// depth d, pathIndices[d] is 0 if `slot`'s node is the left child at that
// depth (sibling is on the right) and 1 if it's the right child.
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

// Builds the exact circuit-input object for circuits/settlement.circom.
//
// `overrideBalance`, when set, is written into the witness's `balance`
// signal in place of the account's real (tree-committed) balance. The
// custodian's signature was computed over the *real* leaf, so this override
// now fails two ways at once: the recomputed leaf no longer matches what
// the custodian signed (EdDSA check fails) AND no longer matches what was
// hashed into the tree (Merkle check fails). Whichever assertion the
// witness calculator reaches first is the one reported — see AUDIT.md for
// which one that empirically is on the current compiled circuit.
//
// Proving for a `blocked: 1` account (1005) with no override at all fails
// on its own, at the `blocked === 0` constraint — a genuinely-signed,
// genuinely-in-tree, above-threshold account that the custodian has simply
// flagged. Distinct from a balance mismatch.
//
// `corruptPath`, when true, flips one bit of the first pathElement — the
// balance, salt, blocked flag and signature are all left genuine, so this
// is the one tamper case that exercises the Merkle check in isolation
// (mp.root === merkleRoot) rather than the signature check, since nothing
// about the leaf itself is wrong, only the claimed path to the root.
async function witnessFor(accountId, { threshold, tradeId, overrideBalance, corruptPath } = {}) {
  const tree = await buildTree();
  const slot = slotIndexOf(tree, accountId);
  const account = tree.accounts[slot];
  const { pathElements, pathIndices } = pathFor(tree, slot);

  const balanceForWitness = overrideBalance !== undefined ? BigInt(overrideBalance) : BigInt(account.balance);
  const pathElementsForWitness = corruptPath
    ? [(BigInt(pathElements[0]) + 1n).toString(), ...pathElements.slice(1).map(String)]
    : pathElements.map(String);

  return {
    input: {
      balance: balanceForWitness.toString(),
      salt: account.salt.toString(),
      accountId: String(account.accountId),
      blocked: String(account.blocked),
      attestationR8x: account.attestation.R8x.toString(),
      attestationR8y: account.attestation.R8y.toString(),
      attestationS: account.attestation.S.toString(),
      pathElements: pathElementsForWitness,
      pathIndices: pathIndices.map(String),
      merkleRoot: tree.root.toString(),
      threshold: String(threshold),
      tradeId: String(tradeId),
      custodianPubKeyAx: tree.custodianPubKey.Ax.toString(),
      custodianPubKeyAy: tree.custodianPubKey.Ay.toString(),
    },
    tree,
    account,
    tamperedBalance: overrideBalance !== undefined,
    tamperedPath: Boolean(corruptPath),
  };
}

async function getRoot() {
  const tree = await buildTree();
  return tree.root.toString();
}

async function getCustodianPubKey() {
  const tree = await buildTree();
  return { Ax: tree.custodianPubKey.Ax.toString(), Ay: tree.custodianPubKey.Ay.toString() };
}

function getBook() {
  return BOOK.map(({ accountId, balance, blocked, name, role }) => ({ accountId, balance, blocked, name, role }));
}

module.exports = { DEPTH, NUM_LEAVES, BOOK, buildTree, witnessFor, getRoot, getCustodianPubKey, getBook, slotIndexOf, pathFor, isUsingDefaultCustodianKey };

// CLI entry point: print the root, the book, and a sample honest + tampered
// witness so this is checkable directly (`node scripts/build-tree.js`).
if (require.main === module) {
  (async () => {
    const tree = await buildTree();
    console.log('Custodian Merkle root:', tree.root.toString());
    console.log();
    console.log('Book:');
    for (const a of tree.accounts) {
      console.log(`  ${a.accountId}  $${a.balance.toLocaleString()}  blocked=${a.blocked}  ${a.name} — ${a.role}`);
    }

    console.log();
    console.log('--- honest witness, account 1001, threshold 1,000,000 ---');
    const honest = await witnessFor(1001, { threshold: 1000000, tradeId: 20260907001 });
    console.log(JSON.stringify(honest.input, null, 2));

    console.log();
    console.log('--- tampered witness, account 1003 claiming its tree-committed balance is higher ---');
    const tampered = await witnessFor(1003, { threshold: 1000000, tradeId: 20260907001, overrideBalance: 5000000 });
    console.log(JSON.stringify(tampered.input, null, 2));
    console.log();
    console.log('(this witness will fail: the custodian signed the leaf with the real $250,000');
    console.log(' balance, so recomputing the leaf with $5,000,000 instead breaks both the');
    console.log(' signature check and the Merkle root check — see AUDIT.md for which one the');
    console.log(' witness calculator actually reports first on the compiled circuit.)');

    console.log();
    console.log('--- blocked-account witness, account 1005, no override needed ---');
    const blocked = await witnessFor(1005, { threshold: 1000000, tradeId: 20260907001 });
    console.log(JSON.stringify(blocked.input, null, 2));
    console.log();
    console.log('(this witness will fail at blocked === 0 — 1005 clears the balance bar');
    console.log(' comfortably but is custodian-flagged blocked in its own signed leaf.)');
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
