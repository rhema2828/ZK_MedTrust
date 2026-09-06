/*
 * PHASE 7 - one-shot CLI: prove an accuracy claim against the REAL
 * circuits/accuracy.circom, for the FastAPI backend to shell out to.
 *
 * Reads {"correct": N, "total": M, "threshold": T} as JSON on stdin.
 * Requires the circuit to already be compiled and Groth16 setup already
 * run (zk/scripts/phase5_accuracy.sh or phase6_pipeline.sh, at least once)
 * - a real deployment's trusted setup happens ONCE, offline, not per
 * request; this script deliberately does not run it itself.
 *
 * Three possible outcomes, distinguished by exit code so the Python side
 * can respond correctly instead of treating everything as one kind of
 * failure:
 *
 *   exit 0  -> stdout is {"proof": {...}, "publicSignals": [...]}
 *              a real Groth16 proof was generated.
 *   exit 2  -> stdout is {"error": "claim_not_provable", "message": "..."}
 *              the circuit's constraints refused this witness - EXPECTED
 *              behavior for a false claim (see circuits/accuracy.circom),
 *              not a bug. There is no proof to return because none can
 *              exist for a false statement.
 *   exit 3  -> stdout is {"error": "toolchain_not_ready", "message": "..."}
 *              the compiled circuit/zkey aren't present - run the one-time
 *              setup first.
 *   exit 1  -> plain text on stderr, something is actually broken.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { buildAccuracyWitness } from "./witnessBuilder.mjs";

const ZK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(ZK_DIR, "build", "accuracy_js", "accuracy.wasm");
const ZKEY = path.join(ZK_DIR, "build", "accuracy_final.zkey");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(WASM) || !fs.existsSync(ZKEY)) {
    console.log(JSON.stringify({
      error: "toolchain_not_ready",
      message: `Missing ${!fs.existsSync(WASM) ? WASM : ZKEY} - run ` +
        `'bash scripts/phase5_accuracy.sh' or 'bash scripts/phase6_pipeline.sh' ` +
        `once first (the one-time Groth16 setup; a real deployment does this ` +
        `offline, not per request).`,
    }));
    process.exit(3);
  }

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (err) {
    console.error(`Malformed JSON on stdin: ${err.message}`);
    process.exit(1);
  }

  let witness;
  try {
    witness = buildAccuracyWitness(input);
  } catch (err) {
    console.log(JSON.stringify({ error: "claim_not_provable", message: err.message }));
    process.exit(2);
  }

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
    console.log(JSON.stringify({ proof, publicSignals }));
    process.exit(0);
  } catch (err) {
    // fullProve throws when witness generation itself fails - this is the
    // circuit's constraints correctly refusing a false claim, exactly the
    // scripts/phase6_pipeline.sh behavior, just reached via the JS API
    // instead of the CLI witness calculator.
    console.log(JSON.stringify({
      error: "claim_not_provable",
      message: `The circuit's constraints refused this claim - no proof exists for it: ${err.message}`,
    }));
    process.exit(2);
  } finally {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }
}

main();
