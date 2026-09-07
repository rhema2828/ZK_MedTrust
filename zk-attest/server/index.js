'use strict';
//
// ZK-Attest server. Thin wrapper around snarkjs — no business logic beyond
// picking which witness to build and which public signal to mutate for the
// forged-proof demo. Every timing number below is measured with Date.now()
// around the actual snarkjs call that produced it; none is hardcoded.
//
// CORS is open (`cors()` with no origin restriction) so a frontend running
// on any other port/origin — the other team member's dev server — can call
// every endpoint below with no configuration on their end. This mirrors the
// medical-imaging backend elsewhere in this repo, which does the same for
// the same reason: this is a local demo server, not a production API.

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const snarkjs = require('snarkjs');
const { witnessFor, getRoot, getCustodianPubKey, getBook, DEPTH } = require('../scripts/build-tree');

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

// This value is not read from anywhere else — it's this file's own record
// of which structural features are baked into circuits/settlement.circom as
// committed. It has to be updated by hand if the circuit changes again,
// same as circuitStats.source below says about itself.
const CIRCUIT_VERSION = 'phase1-item2-attestation';

// Re-verified against this exact compiled circuit by triggering each case
// and reading the real witness-calculator error, on 2026-09-07 — not
// guessed. Adding custodian attestation changed more than the line numbers:
// the EdDSA verifier is a *subcomponent*, so a signature failure surfaces as
// a multi-line call chain naming its own internal templates
// (ForceEqualIfEnabled -> EdDSAPoseidonVerifier -> Settlement), not a single
// "Settlement line: N". A balance-tamper attempt now fails here first
// (the custodian signed the real balance, so recomputing the leaf with a
// different one breaks the signature before the Merkle check is even
// reached) rather than at the Merkle line, which is what it hit before
// attestation existed.
//
// Top-level Settlement hard-constraint lines (no subcomponent involved):
// line 99 is the Merkle-path check, line 105 is the balance comparator,
// line 108 is the custodian block-flag check.
const FAILURE_LINE_MERKLE = 99;
const FAILURE_LINE_THRESHOLD = 105;
const FAILURE_LINE_BLOCKED = 108;

function classifyWitnessFailure(err) {
  const message = String((err && err.message) || err);

  // A failure inside the custodian-signature subcomponent names its own
  // templates in the call chain — check for those before falling back to a
  // bare Settlement line number, since the regex below would otherwise
  // match the *innermost* line (e.g. inside comparators.circom) rather
  // than anything meaningful on its own.
  if (/EdDSAPoseidonVerifier|ForceEqualIfEnabled/.test(message)) {
    return {
      failedAt: 'attestation',
      error:
        'This leaf’s claimed balance and block status do not carry a valid signature from the known custodian key. The proof cannot be constructed.',
    };
  }

  const settlementLines = [...message.matchAll(/Settlement_\d+ line:\s*(\d+)/g)].map((m) => Number(m[1]));
  const line = settlementLines.length ? settlementLines[settlementLines.length - 1] : null;

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
  if (line === FAILURE_LINE_BLOCKED) {
    return {
      failedAt: 'blocked',
      error:
        'The account is in the custodian’s tree and clears the balance threshold, but the custodian’s own leaf marks it blocked. The proof cannot be constructed.',
    };
  }
  return {
    failedAt: 'unknown',
    error: `Witness generation failed: ${message}`,
  };
}

// ---------------------------------------------------------------- audit log
//
// Persisted to build/audit-log.jsonl (one JSON object per line, append-only)
// so a server restart doesn't lose history — the in-memory array is seeded
// from that file at boot. AUDIT_LOG_MAX_ENTRIES only caps what GET
// /api/audit-log *serves*; the file itself is never truncated. Every
// /api/prove and /api/tamper call is recorded regardless of outcome. Only
// accountId, timestamp, result, reason (and mode, for tamper calls) are
// kept — never balance, salt, blocked, the signature, or any tree/path
// data, all of which are private witness fields that never belong in a log.
const AUDIT_LOG_PATH = path.join(BUILD, 'audit-log.jsonl');
const AUDIT_LOG_MAX_ENTRIES = 500;

function loadAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A truncated last line (e.g. from a hard-killed process mid-write)
      // is skipped rather than crashing server startup over one bad row.
    }
  }
  return entries.slice(-AUDIT_LOG_MAX_ENTRIES);
}

const auditLog = loadAuditLog();

function recordAudit(entry) {
  const full = { timestamp: new Date().toISOString(), ...entry };
  auditLog.push(full);
  if (auditLog.length > AUDIT_LOG_MAX_ENTRIES) auditLog.shift();
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(full) + '\n');
  } catch (err) {
    // Best-effort: audit logging must never fail the request it's logging.
    console.error('Failed to persist audit log entry:', err);
  }
}

// ------------------------------------------------------------- prove/verify
//
// Shared by both /api/prove and /api/tamper — builds a witness, calls
// snarkjs, and returns either a proof or a classified failure. Does not
// touch the response or the audit log itself; callers do that, since the
// two endpoints report the outcome differently.
async function attemptProve({ accountId, threshold, tradeId, overrideBalance, corruptPath }) {
  const book = getBook();
  const account = book.find((a) => a.accountId === Number(accountId));
  if (!account) {
    return { ok: false, status: 400, error: `No account ${accountId} in the custodian's book.` };
  }

  let witness;
  try {
    witness = await witnessFor(Number(accountId), {
      threshold: Number(threshold),
      tradeId: Number(tradeId),
      overrideBalance,
      corruptPath,
    });
  } catch (err) {
    return { ok: false, status: 400, error: String(err.message || err) };
  }

  const t0 = Date.now();
  try {
    const proveResult = await snarkjs.groth16.fullProve(witness.input, WASM_PATH, ZKEY_PATH);
    const proveMs = Date.now() - t0;
    const { proof, publicSignals } = proveResult;
    const proofBytes = Buffer.byteLength(JSON.stringify(proof), 'utf8');
    return {
      ok: true,
      status: 200,
      body: {
        proof,
        publicSignals,
        proveMs,
        constraintCount: circuitStats ? circuitStats.nonLinearConstraints : null,
        proofBytes,
      },
    };
  } catch (err) {
    const { failedAt, error } = classifyWitnessFailure(err);
    return { ok: false, status: 422, error, failedAt };
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'web')));

// ---------------------------------------------------------------- /api/book
//
// Split per party, server-enforced — the previous single GET /api/book
// returned every institution's name and balance to any caller regardless of
// which pane was asking. Treasury is the custodian's own view (everything
// it knows). Exchange is deliberately minimal: the public commitment only,
// no institution names or balances at all, since the whole point of the
// protocol is that the Exchange starts (and stays) knowing nothing beyond
// what a proof reveals.
app.get('/api/book/treasury', async (req, res, next) => {
  try {
    const root = await getRoot();
    const custodianPubKey = await getCustodianPubKey();
    res.json({
      institutions: getBook(),
      merkleRoot: root,
      treeDepth: DEPTH,
      custodianPubKey,
      circuitStats,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/book/exchange', async (req, res, next) => {
  try {
    const root = await getRoot();
    const custodianPubKey = await getCustodianPubKey();
    res.json({
      merkleRoot: root,
      treeDepth: DEPTH,
      custodianPubKey,
      circuitStats,
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- /api/prove
app.post('/api/prove', async (req, res, next) => {
  try {
    const { accountId, threshold, tradeId } = req.body || {};
    if (accountId === undefined || threshold === undefined || tradeId === undefined) {
      return res.status(400).json({ error: 'accountId, threshold and tradeId are required.' });
    }
    if (!Number.isFinite(Number(accountId)) || !Number.isFinite(Number(threshold)) || !Number.isFinite(Number(tradeId))) {
      return res.status(400).json({ error: 'accountId, threshold and tradeId must all be numbers.' });
    }

    const result = await attemptProve({ accountId, threshold, tradeId });
    recordAudit({
      endpoint: 'prove',
      accountId: Number(accountId),
      result: result.ok ? 'success' : 'rejected',
      reason: result.ok ? null : result.failedAt || 'invalid_input',
    });

    if (!result.ok) {
      const body = { error: result.error };
      if (result.failedAt) body.failedAt = result.failedAt;
      return res.status(result.status).json(body);
    }
    res.json(result.body);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- /api/verify
app.post('/api/verify', async (req, res, next) => {
  try {
    const { proof, publicSignals } = req.body || {};
    if (!proof || !publicSignals) {
      return res.status(400).json({ error: 'proof and publicSignals are required.' });
    }

    const t0 = Date.now();
    let valid;
    try {
      valid = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    } catch (err) {
      // A malformed proof/publicSignals shape is a verification failure, not
      // a server error — snarkjs just can't parse it, which means it isn't
      // a valid proof of anything.
      valid = false;
    }
    const verifyMs = Date.now() - t0;
    res.json({ valid, verifyMs });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- /api/tamper
//
// The kill-switch demo, as its own endpoint with an explicit `mode` rather
// than a boolean flag buried in /api/prove — there are now three
// structurally different tamper cases and they need to stay
// distinguishable:
//   - "balance_mismatch": claims a different balance than the one the
//     custodian actually signed for this account. Fails inside the EdDSA
//     verifier (see AUDIT.md for why it moved there once attestation was
//     added — it used to fail at the Merkle check).
//   - "blocked_account": proves for a real, correctly-signed, above-threshold
//     account that the custodian has flagged blocked. No override needed —
//     account 1005 is hardcoded blocked in the tree itself. Fails at the
//     blocked === 0 constraint.
//   - "merkle_mismatch": a genuinely-signed, genuinely-above-threshold,
//     genuinely-unblocked account, but with one Merkle sibling corrupted —
//     everything about the leaf itself is real, only the claimed path to
//     the root is wrong. This is the one mode that isolates the Merkle
//     check on its own, now that balance_mismatch no longer reaches it
//     (the signature check catches that case first).
app.post('/api/tamper', async (req, res, next) => {
  try {
    const { mode, accountId, threshold, tradeId } = req.body || {};
    if (mode !== 'balance_mismatch' && mode !== 'blocked_account' && mode !== 'merkle_mismatch') {
      return res.status(400).json({ error: 'mode must be "balance_mismatch", "blocked_account", or "merkle_mismatch".' });
    }
    if (threshold === undefined || tradeId === undefined) {
      return res.status(400).json({ error: 'threshold and tradeId are required.' });
    }

    let targetAccountId;
    let overrideBalance;
    let corruptPath;
    if (mode === 'blocked_account') {
      targetAccountId = 1005; // the demo's hardcoded blocked account — no override needed
    } else if (mode === 'merkle_mismatch') {
      targetAccountId = accountId !== undefined ? Number(accountId) : 1001; // any genuinely-clear account works; 1001 by default
      const book = getBook();
      if (!book.find((a) => a.accountId === targetAccountId)) {
        return res.status(400).json({ error: `No account ${targetAccountId} in the custodian's book.` });
      }
      corruptPath = true;
    } else {
      if (accountId === undefined) {
        return res.status(400).json({ error: 'accountId is required for mode "balance_mismatch".' });
      }
      const book = getBook();
      const account = book.find((a) => a.accountId === Number(accountId));
      if (!account) {
        return res.status(400).json({ error: `No account ${accountId} in the custodian's book.` });
      }
      targetAccountId = Number(accountId);
      overrideBalance = Math.max(Number(threshold) + 1, account.balance + 1);
    }

    const result = await attemptProve({ accountId: targetAccountId, threshold, tradeId, overrideBalance, corruptPath });
    recordAudit({
      endpoint: 'tamper',
      accountId: targetAccountId,
      result: result.ok ? 'success' : 'rejected',
      reason: result.ok ? null : result.failedAt || 'invalid_input',
      mode,
    });

    if (result.ok) {
      // A tamper request that actually succeeds means the demo's own
      // assumptions broke (e.g. someone raised the threshold below 1005's
      // real balance) — report it plainly rather than hiding it as if it
      // were the expected outcome.
      return res.json({ ...result.body, mode, expectedRejection: true, actuallyRejected: false });
    }
    res.status(result.status).json({ error: result.error, failedAt: result.failedAt, mode, expectedRejection: true, actuallyRejected: true });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- /api/status
app.get('/api/status', (req, res) => {
  res.json({
    circuitVersion: CIRCUIT_VERSION,
    constraintCount: circuitStats ? circuitStats.nonLinearConstraints : null,
    circuitStats,
    blocklistActive: true,
    attestationActive: true,
    depth: DEPTH,
  });
});

// ----------------------------------------------------------- /api/audit-log
app.get('/api/audit-log', (req, res) => {
  res.json({ entries: auditLog, count: auditLog.length, maxEntries: AUDIT_LOG_MAX_ENTRIES });
});

// ------------------------------------------------------------- 404 + errors
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}.` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

module.exports = { app };

// Only bind a port when this file is run directly (`node server/index.js`),
// not when it's imported — the test suite imports `app` and binds its own
// ephemeral port so tests don't collide with a real running server.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`ZK-Attest server listening on http://localhost:${PORT}`);
  });
}
