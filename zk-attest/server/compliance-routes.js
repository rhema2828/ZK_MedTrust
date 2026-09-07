'use strict';
//
// Compliance-verification API — separate router, mounted into the main
// app in server/index.js. Mirrors that file's own patterns (attemptProve
// -> classify failure -> audit log) applied to the compliance circuit
// instead of the settlement circuit, so the two feature areas stay
// structurally consistent without literally sharing code that has no
// reason to be shared (different circuit, different witness shape,
// different failure-line numbers).
const path = require('path');
const fs = require('fs');
const express = require('express');
const snarkjs = require('snarkjs');

const { CRITERIA, NUM_CRITERIA } = require('../compliance/criteria');
const { allCases, caseById, summaryFor } = require('../compliance/db');
const { commentaryFor } = require('../compliance/ai-commentary');
const {
  witnessFor,
  getComplianceRoot,
  getAuthorityPubKey,
  explainComplianceWitness,
  isUsingDefaultAuthorityKey,
} = require('../compliance/build-compliance-tree');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build', 'compliance');
const WASM_PATH = path.join(BUILD, 'compliance_js', 'compliance.wasm');
const ZKEY_PATH = path.join(BUILD, 'compliance_final.zkey');
const VKEY_PATH = path.join(BUILD, 'verification_key.json');

const artifactsReady = [WASM_PATH, ZKEY_PATH, VKEY_PATH].every((p) => fs.existsSync(p));
const verificationKey = artifactsReady ? JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8')) : null;

if (isUsingDefaultAuthorityKey()) {
  console.warn(
    'WARNING: using the built-in demo compliance-authority key (COMPLIANCE_AUTHORITY_KEY_SEED env var not set). ' +
      "This key is public in this repository's source. Fine for a demo; never use it for anything where the " +
      'signature needs to mean something.',
  );
}

// Failure-line numbers from circuits/compliance.circom, read directly off
// that file (grep -n '===') rather than hand-copied from memory — see
// server/index.js's identical rationale for the settlement circuit.
const FAILURE_LINE_BIT_RANGE = 95; // bits[i] must be 0 or 1
const FAILURE_LINE_MERKLE = 133; // mp.root === merkleRoot
const FAILURE_LINE_THRESHOLD_RANGE = 155; // passThreshold <= NUM_CRITERIA
const FAILURE_LINE_THRESHOLD = 161; // passCount >= passThreshold

function classifyWitnessFailure(err) {
  const message = String((err && err.message) || err);

  if (/EdDSAPoseidonVerifier|ForceEqualIfEnabled/.test(message)) {
    return {
      failedAt: 'attestation',
      error: "This case's claimed criteria results do not carry a valid signature from the known compliance-authority key. The proof cannot be constructed.",
    };
  }

  const lines = [...message.matchAll(/ComplianceThreshold_\d+ line:\s*(\d+)/g)].map((m) => Number(m[1]));
  const line = lines.length ? lines[lines.length - 1] : null;

  if (line === FAILURE_LINE_MERKLE) {
    return {
      failedAt: 'merkleRoot',
      error: "The case named in this witness does not correspond to a leaf that hashes into the compliance authority's attested tree. The proof cannot be constructed.",
    };
  }
  if (line === FAILURE_LINE_THRESHOLD) {
    return {
      failedAt: 'threshold',
      error: 'The case is genuinely in the compliance-authority tree, but it does not pass enough of the 20 criteria to clear the claimed threshold. The proof cannot be constructed.',
    };
  }
  if (line === FAILURE_LINE_THRESHOLD_RANGE || line === FAILURE_LINE_BIT_RANGE) {
    return { failedAt: 'invalidInput', error: `Witness generation failed: an input value was out of its valid range (circuit line ${line}).` };
  }
  return { failedAt: 'unknown', error: `Witness generation failed: ${message}` };
}

// Persisted the same way server/index.js's settlement audit log is —
// append-only JSONL under build/, reloaded at boot, capped on read.
const AUDIT_LOG_PATH = path.join(ROOT, 'build', 'compliance-audit-log.jsonl');
const AUDIT_LOG_MAX_ENTRIES = 500;

function loadAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // truncated last line from a hard-killed process -- skip, don't crash boot
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
    console.error('Failed to persist compliance audit log entry:', err);
  }
}

const router = express.Router();

// --------------------------------------------------------- /api/compliance
//
// The full case list with real per-criterion pass/fail, the aggregate
// count, and — for the 6 qualitative criteria (see criteria.js) — the
// real independently-reasoned AI commentary (ai-commentary.js). This is
// exactly what a user should see "when they open the application": what
// criteria the sample cases were tested against, and whether they passed.
router.get('/api/compliance/cases', async (req, res, next) => {
  try {
    const rows = allCases();
    const merkleRoot = await getComplianceRoot();
    const authorityPubKey = await getAuthorityPubKey();
    res.json({
      criteria: CRITERIA.map(({ key, label, qualitative }) => ({ key, label, qualitative: Boolean(qualitative) })),
      cases: rows.map((row) => ({ ...summaryFor(row), aiCommentary: commentaryFor(row.case_id) })),
      merkleRoot,
      authorityPubKey,
      circuit: { name: 'compliance.circom', numCriteria: NUM_CRITERIA },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/api/compliance/cases/:caseId', async (req, res, next) => {
  try {
    const row = caseById(req.params.caseId);
    if (!row) return res.status(404).json({ error: `No case ${req.params.caseId} in the compliance dataset.` });
    res.json({ ...summaryFor(row), aiCommentary: commentaryFor(row.case_id) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- /api/compliance/witness
//
// Demo-only transparency endpoint, same rationale as GET
// /api/witness/:accountId in server/index.js: reveals the real leaf
// construction (bits, salt, group hashes, signature, Merkle path) that
// the ZK proof otherwise keeps private. Safe here because every case's
// pass/fail statuses are already shown by GET /api/compliance/cases.
router.get('/api/compliance/witness/:caseId', async (req, res, next) => {
  try {
    const row = caseById(req.params.caseId);
    if (!row) return res.status(404).json({ error: `No case ${req.params.caseId} in the compliance dataset.` });
    const explanation = await explainComplianceWitness(req.params.caseId);
    res.json(explanation);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------- /api/compliance/prove
//
// Generates a real Groth16 proof that a case passes at least
// `passThreshold` of its 20 real criteria, without revealing which of the
// 20 passed/failed, the case's identity, or its raw field values.
router.post('/api/compliance/prove', async (req, res, next) => {
  try {
    if (!artifactsReady) {
      return res.status(503).json({ error: 'Compliance circuit build artifacts are missing. Run the compliance setup step first.' });
    }
    const { caseId, passThreshold, proofNonce } = req.body || {};
    if (caseId === undefined || passThreshold === undefined || proofNonce === undefined) {
      return res.status(400).json({ error: 'caseId, passThreshold and proofNonce are required.' });
    }
    if (!Number.isFinite(Number(passThreshold)) || !Number.isFinite(Number(proofNonce))) {
      return res.status(400).json({ error: 'passThreshold and proofNonce must be numbers.' });
    }
    const row = caseById(caseId);
    if (!row) return res.status(400).json({ error: `No case ${caseId} in the compliance dataset.` });

    let witness;
    try {
      witness = await witnessFor(caseId, { passThreshold: Number(passThreshold), proofNonce: Number(proofNonce) });
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }

    const t0 = Date.now();
    try {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness.input, WASM_PATH, ZKEY_PATH);
      const proveMs = Date.now() - t0;
      recordAudit({ endpoint: 'prove', caseId, passThreshold: Number(passThreshold), result: 'success', reason: null });
      return res.json({ proof, publicSignals, proveMs, proofBytes: Buffer.byteLength(JSON.stringify(proof), 'utf8'), numCriteria: NUM_CRITERIA });
    } catch (err) {
      const { failedAt, error } = classifyWitnessFailure(err);
      recordAudit({ endpoint: 'prove', caseId, passThreshold: Number(passThreshold), result: 'rejected', reason: failedAt });
      return res.status(422).json({ error, failedAt });
    }
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------- /api/compliance/verify
router.post('/api/compliance/verify', async (req, res, next) => {
  try {
    if (!artifactsReady) {
      return res.status(503).json({ error: 'Compliance circuit build artifacts are missing. Run the compliance setup step first.' });
    }
    const { proof, publicSignals } = req.body || {};
    if (!proof || !publicSignals) {
      return res.status(400).json({ error: 'proof and publicSignals are required.' });
    }
    const t0 = Date.now();
    let valid;
    try {
      valid = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    } catch {
      valid = false;
    }
    res.json({ valid, verifyMs: Date.now() - t0 });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------- /api/compliance/audit-log
router.get('/api/compliance/audit-log', (req, res) => {
  res.json({ entries: auditLog, count: auditLog.length, maxEntries: AUDIT_LOG_MAX_ENTRIES });
});

module.exports = { router, artifactsReady };
