/*
 * PHASE 5 ACCURACY CIRCUIT TESTS
 *
 * Mirrors test/square.test.mjs's structure. The interesting difference: most
 * negative cases here are HARD CONSTRAINTS the circuit enforces (0 < total,
 * correct <= total, threshold <= 100, accuracy >= threshold), so violating
 * one means no witness can be built at all -- not "a witness exists but
 * produces a proof that fails verification". Only the public-input/proof
 * tamper tests operate on an already-valid proof, for parity with Phase 1.
 *
 * Requires the build artifacts. Run these first:
 *   bash scripts/install_toolchain.sh
 *   bash scripts/ptau.sh
 *   bash scripts/phase5_accuracy.sh
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const ZK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ZK_DIR, "build", "accuracy_js", "accuracy.wasm");
const ZKEY = path.join(ZK_DIR, "build", "accuracy_final.zkey");
const VKEY = path.join(ZK_DIR, "build", "accuracy_verification_key.json");

for (const f of [WASM, ZKEY, VKEY]) {
  if (!fs.existsSync(f)) {
    throw new Error(
      `Missing build artifact: ${f}\n` +
      `Run: bash scripts/ptau.sh && bash scripts/phase5_accuracy.sh`
    );
  }
}

const vKey = JSON.parse(fs.readFileSync(VKEY, "utf8"));

async function verifies(publicSignals, proof) {
  try {
    return await snarkjs.groth16.verify(vKey, publicSignals, proof);
  } catch {
    return false;
  }
}

// 90/100 = 90%, clearing an 85% threshold. The verifier only ever sees
// total_predictions and threshold -- correct_predictions never appears.
const HONEST_INPUT = { correct_predictions: 90, total_predictions: 100, threshold: 85 };

async function honestProof() {
  return snarkjs.groth16.fullProve(HONEST_INPUT, WASM, ZKEY);
}

test("a valid accuracy claim (90% >= 85%) verifies", async () => {
  const { proof, publicSignals } = await honestProof();

  // Public signals are [valid, total_predictions, threshold] in declaration
  // order. correct_predictions (90) must not appear anywhere in this array.
  assert.deepEqual(publicSignals, ["1", "100", "85"]);

  const ok = await verifies(publicSignals, proof);
  assert.equal(ok, true, "an honest accuracy proof should verify");
});

test("tampering with the public threshold makes verification fail", async () => {
  const { proof, publicSignals } = await honestProof();

  // Reuse the proof built for threshold=85, claim threshold=10 instead.
  const tampered = [...publicSignals];
  tampered[2] = "10";

  const ok = await verifies(tampered, proof);
  assert.equal(ok, false, "a proof must not verify against a different threshold");
});

test("tampering with the proof makes verification fail", async () => {
  const { proof, publicSignals } = await honestProof();

  const tampered = JSON.parse(JSON.stringify(proof));
  tampered.pi_a[0] = (BigInt(tampered.pi_a[0]) + 1n).toString();

  const ok = await verifies(publicSignals, tampered);
  assert.equal(ok, false, "a corrupted proof must not verify");
});

test("accuracy below threshold cannot produce a witness (80% < 85%)", async () => {
  await assert.rejects(
    () => snarkjs.groth16.fullProve(
      { correct_predictions: 80, total_predictions: 100, threshold: 85 }, WASM, ZKEY
    ),
    "witness generation must fail when accuracy does not clear the threshold"
  );
});

test("correct_predictions > total_predictions cannot produce a witness", async () => {
  await assert.rejects(
    () => snarkjs.groth16.fullProve(
      { correct_predictions: 110, total_predictions: 100, threshold: 85 }, WASM, ZKEY
    ),
    "witness generation must fail when correct exceeds total"
  );
});

test("total_predictions = 0 cannot produce a witness", async () => {
  await assert.rejects(
    () => snarkjs.groth16.fullProve(
      { correct_predictions: 0, total_predictions: 0, threshold: 85 }, WASM, ZKEY
    ),
    "witness generation must fail when total_predictions is zero"
  );
});

test("threshold > 100 cannot produce a witness", async () => {
  await assert.rejects(
    () => snarkjs.groth16.fullProve(
      { correct_predictions: 90, total_predictions: 100, threshold: 150 }, WASM, ZKEY
    ),
    "witness generation must fail when threshold exceeds 100"
  );
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});
