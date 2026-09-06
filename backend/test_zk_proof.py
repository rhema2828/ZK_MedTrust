"""PHASE 7 TESTS - the Python <-> Node ZK bridge (backend/zk_proof.py).

These call the REAL circuit via the REAL node/snarkjs toolchain - no
mocking. They skip themselves (not fail) if the one-time Groth16 setup
hasn't been run yet in this environment, the same pattern
zk/evaluation/test_evaluate.py's RealModelIntegrationTest already uses for
its own real-model dependency.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import zk_proof  # noqa: E402


def _toolchain_ready_or_skip(test_case):
    if not zk_proof.zk_toolchain_ready():
        test_case.skipTest(
            "ZK toolchain not set up - run 'bash zk/scripts/phase5_accuracy.sh' or "
            "'bash zk/scripts/phase6_pipeline.sh' at least once first."
        )


class GenerateAccuracyProofTests(unittest.TestCase):
    def setUp(self):
        _toolchain_ready_or_skip(self)

    def test_valid_claim_produces_a_real_proof(self):
        result = zk_proof.generate_accuracy_proof(correct=8, total=10, threshold=70)
        self.assertIn("proof", result)
        self.assertIn("publicSignals", result)
        self.assertEqual(result["proof"]["protocol"], "groth16")
        # correct_predictions must never appear among the public signals -
        # that is the entire point of it being the circuit's private input.
        self.assertNotIn("8", result["publicSignals"])

    def test_exact_boundary_claim_succeeds(self):
        # 7/10 = 70% >= 70% - the circuit's >= (not >) must accept this.
        result = zk_proof.generate_accuracy_proof(correct=7, total=10, threshold=70)
        self.assertIn("proof", result)

    def test_false_claim_raises_claim_not_provable(self):
        with self.assertRaises(zk_proof.ClaimNotProvableError):
            zk_proof.generate_accuracy_proof(correct=5, total=10, threshold=70)

    def test_total_zero_raises_claim_not_provable(self):
        # Caught by buildAccuracyWitness's own range check before the
        # circuit is even invoked - still surfaces as the same error type.
        with self.assertRaises(zk_proof.ClaimNotProvableError):
            zk_proof.generate_accuracy_proof(correct=0, total=0, threshold=50)

    def test_correct_greater_than_total_raises_claim_not_provable(self):
        with self.assertRaises(zk_proof.ClaimNotProvableError):
            zk_proof.generate_accuracy_proof(correct=11, total=10, threshold=50)


class VerifyAccuracyProofTests(unittest.TestCase):
    def setUp(self):
        _toolchain_ready_or_skip(self)
        self.result = zk_proof.generate_accuracy_proof(correct=8, total=10, threshold=70)

    def test_honest_proof_verifies(self):
        verified = zk_proof.verify_accuracy_proof(self.result["proof"], self.result["publicSignals"])
        self.assertTrue(verified)

    def test_tampered_public_signal_does_not_verify(self):
        tampered = list(self.result["publicSignals"])
        tampered[-1] = "99"  # claim threshold=99 instead of 70
        verified = zk_proof.verify_accuracy_proof(self.result["proof"], tampered)
        self.assertFalse(verified)

    def test_tampered_proof_does_not_verify(self):
        import copy

        tampered = copy.deepcopy(self.result["proof"])
        tampered["pi_a"][0] = str(int(tampered["pi_a"][0]) + 1)
        verified = zk_proof.verify_accuracy_proof(tampered, self.result["publicSignals"])
        self.assertFalse(verified)

    def test_malformed_proof_does_not_verify_and_does_not_raise(self):
        verified = zk_proof.verify_accuracy_proof({"not": "a real proof"}, ["1", "2", "3"])
        self.assertFalse(verified)

    def test_proof_from_one_claim_does_not_verify_against_a_different_claim(self):
        other = zk_proof.generate_accuracy_proof(correct=3, total=10, threshold=20)
        verified = zk_proof.verify_accuracy_proof(self.result["proof"], other["publicSignals"])
        self.assertFalse(verified)


class ZkToolchainReadyTests(unittest.TestCase):
    def test_returns_a_bool(self):
        self.assertIsInstance(zk_proof.zk_toolchain_ready(), bool)


if __name__ == "__main__":
    unittest.main()
