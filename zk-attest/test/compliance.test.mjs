/*
 * ZK-ATTEST COMPLIANCE TESTS
 *
 * Exercises the real compliance router (server/compliance-routes.js,
 * mounted into the same app server.test.mjs already tests) against the
 * real 15-case dataset loaded from compliance/compliance_cases.sql into a
 * real SQLite database, with real Groth16 proving/verification — no
 * mocking. Requires the compliance circuit's build artifacts:
 *
 *   (from zk-attest/) circom + snarkjs groth16 setup against
 *   circuits/compliance.circom -- see compliance/README.md.
 *
 * Every proof-generating test is slow (real Groth16 proving) — expected,
 * not a bug in the tests.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ZK_ATTEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VKEY_PATH = path.join(ZK_ATTEST_DIR, 'build', 'compliance', 'verification_key.json');

for (const f of [VKEY_PATH]) {
  if (!fs.existsSync(f)) {
    throw new Error(`Missing compliance build artifact: ${f}\nRun the compliance circuit setup first.`);
  }
}

const vKey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));

const serverModule = (await import('../server/index.js')).default;
const { app } = serverModule;

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------ /api/compliance/cases

test('GET /api/compliance/cases returns all 15 real cases with 20 real criteria each', async () => {
  const { status, body } = await get('/api/compliance/cases');
  assert.equal(status, 200);
  assert.equal(body.criteria.length, 20);
  assert.equal(body.cases.length, 15);
  for (const c of body.cases) {
    assert.equal(c.criteria.length, 20);
    assert.equal(c.totalCriteria, 20);
    assert.equal(c.passCount, c.criteria.filter((x) => x.pass).length);
  }
  assert.ok(body.merkleRoot);
  assert.ok(body.authorityPubKey.Ax);
});

test('GET /api/compliance/cases: 14 cases pass all 20 criteria, CASE-015 passes only 11', async () => {
  const { body } = await get('/api/compliance/cases');
  const clean = body.cases.filter((c) => c.caseId !== 'CASE-015');
  assert.equal(clean.length, 14);
  for (const c of clean) assert.equal(c.passCount, 20);

  const flagged = body.cases.find((c) => c.caseId === 'CASE-015');
  assert.equal(flagged.passCount, 11);
  assert.equal(flagged.aiCommentary.assessment, 'FLAGGED');
});

test('GET /api/compliance/cases/:caseId returns one case with AI commentary for a clean case', async () => {
  const { status, body } = await get('/api/compliance/cases/CASE-001');
  assert.equal(status, 200);
  assert.equal(body.institution, 'Northstar Capital');
  assert.equal(body.passCount, 20);
  assert.equal(body.aiCommentary.assessment, 'CONSISTENT');
});

test('GET /api/compliance/cases/:caseId 404s for an unknown case', async () => {
  const { status, body } = await get('/api/compliance/cases/CASE-999');
  assert.equal(status, 404);
  assert.ok(body.error);
});

// ------------------------------------------------------------ /api/compliance/witness

test('GET /api/compliance/witness/:caseId exposes the real leaf construction, matching the committed root', async () => {
  const { status, body } = await get('/api/compliance/witness/CASE-015');
  assert.equal(status, 200);
  assert.equal(body.caseId, 'CASE-015');
  assert.equal(body.caseIndex, 15);
  assert.equal(body.bits.length, 20);
  assert.equal(body.bits.reduce((a, b) => a + b, 0), 11);
  assert.ok(body.leafHash);
  assert.ok(body.attestation.S);

  const cases = await get('/api/compliance/cases');
  assert.equal(body.merkleRoot, cases.body.merkleRoot);
  assert.deepEqual(body.authorityPubKey, cases.body.authorityPubKey);
});

test('GET /api/compliance/witness/:caseId is internally consistent: recomputing the two group Poseidon hashes and the leaf matches', async () => {
  const { buildPoseidon } = await import('circomlibjs');
  const poseidon = await buildPoseidon();
  const { body } = await get('/api/compliance/witness/CASE-001');

  const group1 = poseidon.F.toObject(poseidon(body.bits.slice(0, 10).map(BigInt)));
  const group2 = poseidon.F.toObject(poseidon(body.bits.slice(10).map(BigInt)));
  assert.equal(group1.toString(), body.group1);
  assert.equal(group2.toString(), body.group2);

  const leaf = poseidon.F.toObject(poseidon([BigInt(body.caseIndex), BigInt(body.salt), group1, group2]));
  assert.equal(leaf.toString(), body.leafHash);
});

// ------------------------------------------------------------ /api/compliance/prove

test('POST /api/compliance/prove: a case passing all 20 criteria clears an 18-of-20 threshold with a real, verifiable proof', async () => {
  const { status, body } = await post('/api/compliance/prove', { caseId: 'CASE-001', passThreshold: 18, proofNonce: 1 });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['numCriteria', 'proof', 'proofBytes', 'proveMs', 'publicSignals'].sort());
  // No case identity, bits, salt, or path data anywhere in the response.
  assert.equal(JSON.stringify(body).includes('CASE-001'), false);

  assert.equal(body.publicSignals.length, 5);
  const [, threshold, nonce] = body.publicSignals;
  assert.equal(threshold, '18');
  assert.equal(nonce, '1');

  const valid = await snarkjs.groth16.verify(vKey, body.publicSignals, body.proof);
  assert.equal(valid, true);
});

test('POST /api/compliance/prove: CASE-015 (11/20) fails to produce a witness at an 18-of-20 threshold', async () => {
  const { status, body } = await post('/api/compliance/prove', { caseId: 'CASE-015', passThreshold: 18, proofNonce: 2 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'threshold');
});

test('POST /api/compliance/prove: CASE-015 (11/20) DOES clear a 10-of-20 threshold -- the boundary is real, not always-reject', async () => {
  const { status, body } = await post('/api/compliance/prove', { caseId: 'CASE-015', passThreshold: 10, proofNonce: 3 });
  assert.equal(status, 200);
  const valid = await snarkjs.groth16.verify(vKey, body.publicSignals, body.proof);
  assert.equal(valid, true);
});

test('POST /api/compliance/prove rejects missing fields with 400', async () => {
  const { status, body } = await post('/api/compliance/prove', {});
  assert.equal(status, 400);
  assert.match(body.error, /required/);
});

test('POST /api/compliance/prove rejects an unknown case with 400', async () => {
  const { status, body } = await post('/api/compliance/prove', { caseId: 'CASE-999', passThreshold: 18, proofNonce: 4 });
  assert.equal(status, 400);
  assert.match(body.error, /No case CASE-999/);
});

// ------------------------------------------------------------ /api/compliance/verify

test('POST /api/compliance/verify accepts a genuine compliance proof', async () => {
  const proveResult = await post('/api/compliance/prove', { caseId: 'CASE-007', passThreshold: 18, proofNonce: 5 });
  const { status, body } = await post('/api/compliance/verify', { proof: proveResult.body.proof, publicSignals: proveResult.body.publicSignals });
  assert.equal(status, 200);
  assert.equal(body.valid, true);
});

test('POST /api/compliance/verify rejects a mutated public signal', async () => {
  const proveResult = await post('/api/compliance/prove', { caseId: 'CASE-008', passThreshold: 18, proofNonce: 6 });
  const mutated = proveResult.body.publicSignals.slice();
  mutated[1] = String(BigInt(mutated[1]) - 1n);
  const { status, body } = await post('/api/compliance/verify', { proof: proveResult.body.proof, publicSignals: mutated });
  assert.equal(status, 200);
  assert.equal(body.valid, false);
});

test('POST /api/compliance/verify rejects missing fields with 400', async () => {
  const { status, body } = await post('/api/compliance/verify', {});
  assert.equal(status, 400);
  assert.match(body.error, /required/);
});

// ------------------------------------------------------------ /api/compliance/audit-log

test('audit log records compliance prove calls without ever including the 20 bits, salt, or signature', async () => {
  await post('/api/compliance/prove', { caseId: 'CASE-002', passThreshold: 18, proofNonce: 7 });
  const { status, body } = await get('/api/compliance/audit-log');
  assert.equal(status, 200);
  assert.ok(body.entries.length >= 1);
  for (const entry of body.entries) {
    assert.deepEqual(
      Object.keys(entry).filter((k) => !['timestamp', 'endpoint', 'caseId', 'passThreshold', 'result', 'reason'].includes(k)),
      [],
    );
  }
});
