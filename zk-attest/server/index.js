'use strict';
//
// ZK-Attest server. Thin wrapper around snarkjs — no business logic beyond
// picking which witness to build and which public signal to mutate for the
// forged-proof demo. Every timing number below is measured with Date.now()
// around the actual snarkjs call that produced it; none is hardcoded.

const path = require('path');
const fs = require('fs');
const express = require('express');
const snarkjs = require('snarkjs');
const { witnessFor, getRoot, getBook, DEPTH } = require('../scripts/build-tree');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const WASM_PATH = path.join(BUILD, 'settlement_js', 'settlement.wasm');
const ZKEY_PATH = path.join(BUILD, 'settlement_final.zkey');
const VKEY_PATH = path.join(BUILD, 'verification_key.json');
const STATS_PATH = path.join(BUILD, 'circuit-stats.json');

for (const p of [WASM_PATH, ZKEY_PATH, VKEY_PATH]) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p}.`);
    console.error('Run `bash scripts/setup.sh` first.');
    process.exit(1);
  }
}

// Loaded once at boot, per the brief — not per request.
const verificationKey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
const circuitStats = fs.existsSync(STATS_PATH) ? JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) : null;

// The circuit has two distinct hard-constraint assert sites (verified
// against the compiled circuit — see PROGRESS notes / commit history, not
// guessed): line 70 is the Merkle-path check, line 76 is the balance
// comparator. A witness that fails to generate at all means one of these
// constraints has no satisfying assignment; snarkjs's witness-calculator
// error names the exact line, so the server reads it rather than assuming
// which one fired.
const FAILURE_LINE_MERKLE = 70;
const FAILURE_LINE_THRESHOLD = 76;

function classifyWitnessFailure(err) {
  const message = String((err && err.message) || err);
  const match = message.match(/line:\s*(\d+)/);
  const line = match ? Number(match[1]) : null;

  if (line === FAILURE_LINE_MERKLE) {
    return {
      failedAt: 'merkleRoot',
      error:
        'The account named in this witness does not correspond to a leaf that hashes into the custodian’s attested tree. The proof cannot be constructed.',
    };
  }
  if (line === FAILURE_LINE_THRESHOLD) {
    return {
      failedAt: 'threshold',
      error:
        'The account is genuinely in the custodian’s tree, but its committed balance does not exceed the threshold. The proof cannot be constructed.',
    };
  }
  return {
    failedAt: 'unknown',
    error: `Witness generation failed: ${message}`,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'web')));

app.get('/api/book', async (req, res) => {
  try {
    const root = await getRoot();
    res.json({
      institutions: getBook(),
      merkleRoot: root,
      treeDepth: DEPTH,
      circuitStats: circuitStats,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/prove', async (req, res) => {
  const { accountId, threshold, tradeId, tamper } = req.body || {};

  if (accountId === undefined || threshold === undefined || tradeId === undefined) {
    return res.status(400).json({ error: 'accountId, threshold and tradeId are required.' });
  }

  let witness;
  try {
    const book = getBook();
    const account = book.find((a) => a.accountId === Number(accountId));
    if (!account) {
      return res.status(400).json({ error: `No account ${accountId} in the custodian's book.` });
    }
    // The tamper toggle claims a balance that clears the threshold while the
    // real, tree-committed balance for the account stays whatever it is —
    // that mismatch is the whole point of the demo case.
    const overrideBalance = tamper ? Math.max(Number(threshold) + 1, account.balance + 1) : undefined;

    witness = await witnessFor(Number(accountId), {
      threshold: Number(threshold),
      tradeId: Number(tradeId),
      overrideBalance,
    });
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }

  let proveResult;
  const t0 = Date.now();
  try {
    proveResult = await snarkjs.groth16.fullProve(witness.input, WASM_PATH, ZKEY_PATH);
  } catch (err) {
    const { failedAt, error } = classifyWitnessFailure(err);
    return res.status(422).json({ error, failedAt });
  }
  const proveMs = Date.now() - t0;

  const { proof, publicSignals } = proveResult;
  const proofBytes = Buffer.byteLength(JSON.stringify(proof), 'utf8');

  res.json({
    proof,
    publicSignals,
    proveMs,
    constraintCount: circuitStats ? circuitStats.nonLinearConstraints : null,
    proofBytes,
  });
});

app.post('/api/verify', async (req, res) => {
  const { proof, publicSignals } = req.body || {};
  if (!proof || !publicSignals) {
    return res.status(400).json({ error: 'proof and publicSignals are required.' });
  }

  const t0 = Date.now();
  let ok;
  try {
    ok = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
  } catch (err) {
    // A malformed proof/publicSignals shape is a verification failure, not a
    // server error — snarkjs just can't parse it, which means it isn't a
    // valid proof of anything.
    ok = false;
  }
  const verifyMs = Date.now() - t0;

  res.json({ ok, verifyMs });
});

app.post('/api/verify-forged', async (req, res) => {
  const { proof, publicSignals, mutate } = req.body || {};
  if (!proof || !publicSignals || !mutate) {
    return res.status(400).json({ error: 'proof, publicSignals and mutate are required.' });
  }
  if (mutate !== 'threshold' && mutate !== 'tradeId') {
    return res.status(400).json({ error: 'mutate must be "threshold" or "tradeId".' });
  }

  // publicSignals order is fixed by the circuit's declaration:
  // component main {public [merkleRoot, threshold, tradeId]}
  const index = mutate === 'threshold' ? 1 : 2;
  const mutated = publicSignals.slice();
  const original = BigInt(mutated[index]);
  mutated[index] = (original + 1n).toString();

  const t0 = Date.now();
  let ok;
  try {
    ok = await snarkjs.groth16.verify(verificationKey, mutated, proof);
  } catch (err) {
    ok = false;
  }
  const verifyMs = Date.now() - t0;

  res.json({ ok, verifyMs, mutated: mutate });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ZK-Attest server listening on http://localhost:${PORT}`);
});
