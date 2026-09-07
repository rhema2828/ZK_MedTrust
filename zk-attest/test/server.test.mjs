/*
 * ZK-ATTEST SERVER TESTS
 *
 * Exercises the real server (server/index.js's exported `app`) on an
 * ephemeral port, with real fetch calls and a real snarkjs verifier — no
 * mocking of the proving/verification path. Requires the build artifacts:
 *
 *   bash scripts/setup.sh
 *
 * Every proof-generating test is slow (real Groth16 proving, ~0.4-0.7s
 * each on this machine) — that's expected, not a bug in the tests.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ZK_ATTEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VKEY_PATH = path.join(ZK_ATTEST_DIR, 'build', 'verification_key.json');

for (const f of [VKEY_PATH]) {
  if (!fs.existsSync(f)) {
    throw new Error(`Missing build artifact: ${f}\nRun: bash scripts/setup.sh`);
  }
}

const vKey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));

// server/index.js is CommonJS (`module.exports = { app }`) — importing it
// as a default export is the interop pattern that doesn't depend on Node's
// named-export static analysis of a CJS file.
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
  return { status: res.status, body: await res.json(), headers: res.headers };
}

// ------------------------------------------------------------ /api/book/*

test('GET /api/book/treasury returns the full book, including the blocked account', async () => {
  const { status, body } = await get('/api/book/treasury');
  assert.equal(status, 200);
  assert.equal(body.institutions.length, 5);
  const blocked = body.institutions.find((a) => a.accountId === 1005);
  assert.equal(blocked.blocked, 1);
  assert.equal(blocked.balance, 9800000);
  assert.ok(body.merkleRoot);
  assert.ok(body.custodianPubKey.Ax);
  assert.ok(body.custodianPubKey.Ay);
});

test('GET /api/book/exchange exposes the commitment but no institution data at all', async () => {
  const { status, body } = await get('/api/book/exchange');
  assert.equal(status, 200);
  assert.equal(body.institutions, undefined);
  assert.equal(JSON.stringify(body).includes('Meridian'), false);
  assert.equal(JSON.stringify(body).includes('12500000'), false);
  assert.ok(body.merkleRoot);
  assert.equal(body.merkleRoot, (await get('/api/book/treasury')).body.merkleRoot);
});

test('GET /api/book (old unauthenticated endpoint) no longer exists', async () => {
  const { status } = await get('/api/book');
  assert.equal(status, 404);
});

// -------------------------------------------------------------- /api/status

test('GET /api/status reports the real constraint count and feature flags', async () => {
  const { status, body } = await get('/api/status');
  assert.equal(status, 200);
  assert.equal(body.constraintCount, 6510);
  assert.equal(body.blocklistActive, true);
  assert.equal(body.attestationActive, true);
  assert.equal(body.depth, 8);
});

// --------------------------------------------------------------- /api/prove

test('POST /api/prove for a genuine account produces a real, verifiable proof with no PII', async () => {
  const { status, body } = await post('/api/prove', { accountId: 1001, threshold: 1000000, tradeId: 1 });
  assert.equal(status, 200);

  // No account identity, balance, block flag, salt, or path data anywhere
  // in the response — only these five keys.
  assert.deepEqual(Object.keys(body).sort(), ['constraintCount', 'proofBytes', 'proveMs', 'proof', 'publicSignals'].sort());
  assert.equal(JSON.stringify(body).includes('12500000'), false);

  // publicSignals order is fixed by the circuit's own declaration.
  assert.equal(body.publicSignals.length, 5);
  const [merkleRoot, threshold, tradeId] = body.publicSignals;
  assert.equal(threshold, '1000000');
  assert.equal(tradeId, '1');

  const valid = await snarkjs.groth16.verify(vKey, body.publicSignals, body.proof);
  assert.equal(valid, true);
});

test('POST /api/prove rejects missing fields with 400', async () => {
  const { status, body } = await post('/api/prove', {});
  assert.equal(status, 400);
  assert.match(body.error, /required/);
});

test('POST /api/prove rejects a nonexistent account with 400', async () => {
  const { status, body } = await post('/api/prove', { accountId: 9999, threshold: 1000000, tradeId: 1 });
  assert.equal(status, 400);
  assert.match(body.error, /No account 9999/);
});

test('POST /api/prove for a genuinely below-threshold account fails at the threshold constraint', async () => {
  const { status, body } = await post('/api/prove', { accountId: 1003, threshold: 1000000, tradeId: 1 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'threshold');
});

// -------------------------------------------------------------- /api/verify

test('POST /api/verify accepts a genuine proof', async () => {
  const proveResult = await post('/api/prove', { accountId: 1002, threshold: 1000000, tradeId: 2 });
  const { status, body } = await post('/api/verify', { proof: proveResult.body.proof, publicSignals: proveResult.body.publicSignals });
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  assert.equal(typeof body.verifyMs, 'number');
});

test('POST /api/verify rejects a mutated public signal', async () => {
  const proveResult = await post('/api/prove', { accountId: 1004, threshold: 1000000, tradeId: 3 });
  const mutated = proveResult.body.publicSignals.slice();
  mutated[1] = String(BigInt(mutated[1]) + 1n); // bump the threshold signal
  const { status, body } = await post('/api/verify', { proof: proveResult.body.proof, publicSignals: mutated });
  assert.equal(status, 200);
  assert.equal(body.valid, false);
});

test('POST /api/verify rejects missing fields with 400', async () => {
  const { status, body } = await post('/api/verify', {});
  assert.equal(status, 400);
  assert.match(body.error, /required/);
});

// -------------------------------------------------------------- /api/tamper

test('POST /api/tamper mode=blocked_account fails at the blocked constraint', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'blocked_account', threshold: 1000000, tradeId: 1 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'blocked');
  assert.equal(body.actuallyRejected, true);
});

test('POST /api/tamper mode=balance_mismatch fails at the attestation (signature) check, not the Merkle check', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'balance_mismatch', accountId: 1003, threshold: 1000000, tradeId: 1 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'attestation');
});

test('POST /api/tamper rejects an invalid mode with 400', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'nonsense', threshold: 1000000, tradeId: 1 });
  assert.equal(status, 400);
  assert.match(body.error, /mode must be/);
});

test('POST /api/tamper mode=balance_mismatch requires accountId', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'balance_mismatch', threshold: 1000000, tradeId: 1 });
  assert.equal(status, 400);
  assert.match(body.error, /accountId is required/);
});

test('POST /api/tamper mode=merkle_mismatch fails at the Merkle check in isolation (real balance, real signature, wrong path)', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'merkle_mismatch', accountId: 1002, threshold: 1000000, tradeId: 1 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'merkleRoot');
});

test('POST /api/tamper mode=merkle_mismatch defaults to account 1001 when accountId is omitted', async () => {
  const { status, body } = await post('/api/tamper', { mode: 'merkle_mismatch', threshold: 1000000, tradeId: 1 });
  assert.equal(status, 422);
  assert.equal(body.failedAt, 'merkleRoot');
});

// --------------------------------------------------------------------- misc

test('unknown route returns 404, not a silent crash', async () => {
  const { status, body } = await get('/api/nonexistent');
  assert.equal(status, 404);
  assert.match(body.error, /No route/);
});

test('CORS is open on a real (non-preflight) request', async () => {
  const { headers } = await get('/api/status');
  assert.equal(headers.get('access-control-allow-origin'), '*');
});

test('audit log records prove/tamper calls without ever including balance, salt, or blocked', async () => {
  await post('/api/prove', { accountId: 1001, threshold: 1000000, tradeId: 99 });
  const { status, body } = await get('/api/audit-log');
  assert.equal(status, 200);
  assert.ok(body.entries.length >= 1);
  for (const entry of body.entries) {
    assert.deepEqual(
      Object.keys(entry).filter((k) => !['timestamp', 'endpoint', 'accountId', 'result', 'reason', 'mode'].includes(k)),
      [],
    );
  }
});
