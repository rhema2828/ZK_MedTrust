/*
 * PHASE 7 - one-shot CLI: verify a Groth16 proof against the REAL
 * circuits/accuracy.circom verification key, for the FastAPI backend to
 * shell out to.
 *
 * Reads {"proof": {...}, "publicSignals": [...]} as JSON on stdin.
 * Always exits 0 and prints {"zk_verified": true|false} - "not verified"
 * is a normal, expected outcome (a tampered proof, wrong public signals,
 * or even malformed input), not an error condition. There is no code path
 * that produces zk_verified:true without snarkjs.groth16.verify() itself
 * returning true against the real verification key.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const ZK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VKEY_PATH = path.join(ZK_DIR, "build", "accuracy_verification_key.json");

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
  if (!fs.existsSync(VKEY_PATH)) {
    console.log(JSON.stringify({
      error: "toolchain_not_ready",
      message: `Missing ${VKEY_PATH} - run the one-time setup first (see proveAccuracy.mjs).`,
    }));
    process.exit(3);
  }
  const vKey = JSON.parse(fs.readFileSync(VKEY_PATH, "utf8"));

  let verified = false;
  try {
    const input = JSON.parse(await readStdin());
    verified = await snarkjs.groth16.verify(vKey, input.publicSignals, input.proof);
  } catch {
    // Malformed input, malformed proof shape, a proof/curve point that
    // isn't even valid, etc. - all of these mean "did not verify," same
    // as snarkjs returning false outright. Never treat a parse/shape
    // error as anything other than not-verified.
    verified = false;
  } finally {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }

  console.log(JSON.stringify({ zk_verified: verified }));
  process.exit(0);
}

main();
