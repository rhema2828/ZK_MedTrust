/*
 * PHASE 1 ZK SANITY TESTS
 *
 * These drive snarkjs through its JavaScript API rather than the CLI, and
 * assert the three things that must be true of any real proof system:
 *
 *   1. an honest proof verifies
 *   2. changing the public input makes verification fail
 *   3. changing the proof makes verification fail
 *
 * Plus one extra: you cannot even build a witness for a false statement.
 *
 * Requires the build artifacts. Run these first:
 *   bash scripts/install_toolchain.sh
 *   bash scripts/ptau.sh
 *   bash scripts/phase1_square.sh
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const ZK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ZK_DIR, "build", "square_js", "square.wasm");
const ZKEY = path.join(ZK_DIR, "build", "square_final.zkey");
const VKEY = path.join(ZK_DIR, "build", "verification_key.json");

for (const f of [WASM, ZKEY, VKEY]) {
  if (!fs.existsSync(f)) {
    throw new Error(
      `Missing build artifact: ${f}\n` +
      `Run: bash scripts/ptau.sh && bash scripts/phase1_square.sh`
    );
  }
}

const vKey = JSON.parse(fs.readFileSync(VKEY, "utf8"));

// snarkjs sometimes returns false and sometimes throws (e.g. when a tampered
// proof is no longer a valid curve point). Both mean "did not verify".
async function verifies(publicSignals, proof) {
  try {
    return await snarkjs.groth16.verify(vKey, publicSignals, proof);
  } catch {
    return false;
  }
}

// The prover knows x = 7. The verifier only ever sees y = 49.
const HONEST_INPUT = { x: 7, y: 49 };

async function honestProof() {
  return snarkjs.groth16.fullProve(HONEST_INPUT, WASM, ZKEY);
}

test("a valid proof verifies", async () => {
  const { proof, publicSignals } = await honestProof();

  // The public signals are the whole of what leaks. x must not appear.
  assert.deepEqual(publicSignals, ["49"]);

  const ok = await verifies(publicSignals, proof);
  assert.equal(ok, true, "an honest proof should verify");
});

test("tampering with the public input makes verification fail", async () => {
  const { proof, publicSignals } = await honestProof();

  // Claim y = 50 while reusing the proof built for y = 49.
  const tampered = [...publicSignals];
  tampered[0] = "50";

  const ok = await verifies(tampered, proof);
  assert.equal(ok, false, "a proof must not verify against a different public input");
});

test("tampering with the proof makes verification fail", async () => {
  const { proof, publicSignals } = await honestProof();

  // Nudge one field element of pi_a off the honest value.
  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.pi_a[0] = (BigInt(tampered.pi_a[0]) + 1n).toString();

  const ok = await verifies(publicSignals, tampered);
  assert.equal(ok, false, "a corrupted proof must not verify");
});

test("a false statement cannot even produce a witness", async () => {
  // 7 * 7 is not 50, so the constraint y === x * x is unsatisfiable here.
  // The prover cannot get as far as generating a proof.
  await assert.rejects(
    () => snarkjs.groth16.fullProve({ x: 7, y: 50 }, WASM, ZKEY),
    "witness generation must fail when the constraint is violated"
  );
});

// snarkjs spins up a worker pool for the bn128 curve and never shuts it down
// on its own. Without this the test process hangs after the last assertion.
after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});
