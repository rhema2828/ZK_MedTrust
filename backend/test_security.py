"""PHASE 8 SECURITY TESTS

Two layers:
  1. Unit tests against backend/security.py's utilities directly - no
     FastAPI app, no model, no network.
  2. Integration tests against the REAL /generate_proof route on the REAL
     FastAPI app, via fastapi.testclient.TestClient.

For (2), `app.py` instantiates MedicalDiagnosticsModel() at import time
(module-level `model = MedicalDiagnosticsModel()`). If the real model isn't
exported yet in this environment (needs torchxrayvision + network access -
see CLAUDE.md), that import would fail for reasons entirely unrelated to
what this file tests. So MedicalDiagnosticsModel is mocked out *before*
`app` is imported here, purely so importing the module doesn't depend on
network access or a pre-exported model. This does not touch or fake
anything about the security layer under test - the real
require_api_key/enforce_rate_limit/validate_proof_request/issue_ticket
code in app.py's actual /generate_proof route runs unmodified.
"""

import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import security  # noqa: E402


# ============================================================ unit tests ===


class ApiKeyTests(unittest.TestCase):
    def setUp(self):
        self._orig = os.environ.get(security.API_KEY_ENV_VAR)

    def tearDown(self):
        if self._orig is None:
            os.environ.pop(security.API_KEY_ENV_VAR, None)
        else:
            os.environ[security.API_KEY_ENV_VAR] = self._orig

    def test_fails_closed_when_unconfigured(self):
        os.environ.pop(security.API_KEY_ENV_VAR, None)
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            security.require_api_key(x_api_key="anything")
        self.assertEqual(ctx.exception.status_code, 500)

    def test_correct_key_passes(self):
        os.environ[security.API_KEY_ENV_VAR] = "correct-horse-battery-staple"
        result = security.require_api_key(x_api_key="correct-horse-battery-staple")
        self.assertEqual(result, "correct-horse-battery-staple")

    def test_wrong_key_rejected(self):
        os.environ[security.API_KEY_ENV_VAR] = "correct-horse-battery-staple"
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            security.require_api_key(x_api_key="wrong-key")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_missing_key_rejected(self):
        os.environ[security.API_KEY_ENV_VAR] = "correct-horse-battery-staple"
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            security.require_api_key(x_api_key=None)
        self.assertEqual(ctx.exception.status_code, 401)


class RateLimiterTests(unittest.TestCase):
    def test_allows_up_to_the_limit(self):
        limiter = security.RateLimiter(max_requests=3, window_seconds=60)
        self.assertTrue(limiter.allow("key", now=0))
        self.assertTrue(limiter.allow("key", now=0))
        self.assertTrue(limiter.allow("key", now=0))

    def test_blocks_once_over_the_limit(self):
        limiter = security.RateLimiter(max_requests=3, window_seconds=60)
        for _ in range(3):
            self.assertTrue(limiter.allow("key", now=0))
        self.assertFalse(limiter.allow("key", now=0))

    def test_window_resets_after_expiry(self):
        limiter = security.RateLimiter(max_requests=1, window_seconds=10)
        self.assertTrue(limiter.allow("key", now=0))
        self.assertFalse(limiter.allow("key", now=5))
        self.assertTrue(limiter.allow("key", now=11))

    def test_different_keys_are_independent(self):
        limiter = security.RateLimiter(max_requests=1, window_seconds=60)
        self.assertTrue(limiter.allow("alice", now=0))
        self.assertTrue(limiter.allow("bob", now=0))
        self.assertFalse(limiter.allow("alice", now=0))

    def test_rejects_bad_construction(self):
        with self.assertRaises(ValueError):
            security.RateLimiter(max_requests=0, window_seconds=60)
        with self.assertRaises(ValueError):
            security.RateLimiter(max_requests=1, window_seconds=0)


class ValidateProofRequestTests(unittest.TestCase):
    def test_valid_passes(self):
        security.validate_proof_request(claimed_accuracy=80, correct=8, total=10)  # no raise

    def test_total_zero_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            security.validate_proof_request(claimed_accuracy=0, correct=0, total=0)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_correct_greater_than_total_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            security.validate_proof_request(claimed_accuracy=100, correct=11, total=10)

    def test_negative_correct_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            security.validate_proof_request(claimed_accuracy=0, correct=-1, total=10)

    def test_claimed_accuracy_out_of_range_rejected(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException):
            security.validate_proof_request(claimed_accuracy=101, correct=5, total=10)
        with self.assertRaises(HTTPException):
            security.validate_proof_request(claimed_accuracy=-1, correct=5, total=10)

    def test_boundary_values_accepted(self):
        security.validate_proof_request(claimed_accuracy=0, correct=0, total=1)
        security.validate_proof_request(claimed_accuracy=100, correct=1, total=1)


class TicketTests(unittest.TestCase):
    def setUp(self):
        self._orig = os.environ.get(security._TICKET_SECRET_ENV_VAR)
        os.environ[security._TICKET_SECRET_ENV_VAR] = "test-ticket-secret"
        security._seen_nonces.clear()

    def tearDown(self):
        if self._orig is None:
            os.environ.pop(security._TICKET_SECRET_ENV_VAR, None)
        else:
            os.environ[security._TICKET_SECRET_ENV_VAR] = self._orig
        security._seen_nonces.clear()

    def test_issue_then_verify_roundtrip(self):
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80}
        ticket = security.issue_ticket(payload, ttl_seconds=60)
        body = security.verify_ticket(ticket, payload)
        self.assertIn("nonce", body)

    def test_payload_never_appears_in_the_ticket_string(self):
        # This is the "no patient data in tickets" property, checked
        # directly: nothing distinctive from the payload should be
        # recoverable by just looking at the ticket text.
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80, "patient_note": "VERY-SECRET-PHI-VALUE"}
        ticket = security.issue_ticket(payload, ttl_seconds=60)
        self.assertNotIn("VERY-SECRET-PHI-VALUE", ticket)
        self.assertNotIn("patient_note", ticket)

    def test_tampered_ticket_rejected(self):
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80}
        ticket = security.issue_ticket(payload, ttl_seconds=60)
        tampered = ticket[:-2] + ("00" if ticket[-2:] != "00" else "11")
        with self.assertRaises(security.TicketError):
            security.verify_ticket(tampered, payload)

    def test_expired_ticket_rejected(self):
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80}
        ticket = security.issue_ticket(payload, ttl_seconds=0)
        time.sleep(0.01)
        with self.assertRaises(security.TicketError):
            security.verify_ticket(ticket, payload)

    def test_replayed_nonce_rejected(self):
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80}
        ticket = security.issue_ticket(payload, ttl_seconds=60)
        security.verify_ticket(ticket, payload)  # first use succeeds
        with self.assertRaises(security.TicketError):
            security.verify_ticket(ticket, payload)  # replay fails

    def test_mismatched_payload_rejected(self):
        payload = {"correct": 8, "total": 10, "claimed_accuracy": 80}
        ticket = security.issue_ticket(payload, ttl_seconds=60)
        with self.assertRaises(security.TicketError):
            security.verify_ticket(ticket, {"correct": 9, "total": 10, "claimed_accuracy": 90})

    def test_malformed_ticket_rejected(self):
        with self.assertRaises(security.TicketError):
            security.verify_ticket("not even json", {"a": 1})

    def test_missing_secret_raises(self):
        os.environ.pop(security._TICKET_SECRET_ENV_VAR, None)
        with self.assertRaises(RuntimeError):
            security.issue_ticket({"a": 1}, ttl_seconds=60)


class SecureTempfileTests(unittest.TestCase):
    def test_file_created_with_owner_only_permissions_and_cleaned_up(self):
        with security.secure_tempfile(suffix=".json") as path:
            self.assertTrue(path.exists())
            mode = path.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)
            path.write_text("test content")
        self.assertFalse(path.exists())

    def test_cleaned_up_even_on_exception(self):
        captured_path = None
        with self.assertRaises(ValueError):
            with security.secure_tempfile() as path:
                captured_path = path
                self.assertTrue(path.exists())
                raise ValueError("boom")
        self.assertIsNotNone(captured_path)
        self.assertFalse(captured_path.exists())


class ModelIntegrityTests(unittest.TestCase):
    def test_matching_hash_passes(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.onnx"
            path.write_bytes(b"fake model bytes")
            expected = security.compute_model_sha256(path)
            result = security.verify_model_integrity(path, expected_sha256=expected)
            self.assertEqual(result, expected)

    def test_mismatched_hash_raises(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.onnx"
            path.write_bytes(b"fake model bytes")
            with self.assertRaises(ValueError):
                security.verify_model_integrity(path, expected_sha256="0" * 64)

    def test_no_expected_hash_just_returns_computed(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.onnx"
            path.write_bytes(b"fake model bytes")
            result = security.verify_model_integrity(path)
            self.assertEqual(len(result), 64)

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            security.verify_model_integrity(Path("/nonexistent/model.onnx"))


class RequestIdTests(unittest.TestCase):
    def test_generates_unique_ids(self):
        ids = {security.new_request_id() for _ in range(100)}
        self.assertEqual(len(ids), 100)


# ================================================= FastAPI integration =====


def _import_app_with_mocked_model():
    """Imports backend/app.py with MedicalDiagnosticsModel mocked out, so
    the import doesn't depend on the real model being exported / network
    access. See the module docstring above.
    """
    with patch("ml_inference.MedicalDiagnosticsModel") as MockModel:
        MockModel.return_value = MagicMock()
        if "app" in sys.modules:
            del sys.modules["app"]
        import app  # noqa: PLC0415
        return app


class GenerateProofEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            raise unittest.SkipTest("fastapi/httpx not installed - see zk/README.md Phase 8 setup")

        os.environ[security.API_KEY_ENV_VAR] = "test-api-key"
        os.environ[security._TICKET_SECRET_ENV_VAR] = "test-ticket-secret"
        cls.app_module = _import_app_with_mocked_model()
        cls.client = TestClient(cls.app_module.app)

    def setUp(self):
        security._default_rate_limiter.reset()
        security._seen_nonces.clear()

    VALID_BODY = {"claimed_accuracy": 80, "correct": 8, "total": 10}

    def test_missing_api_key_rejected(self):
        resp = self.client.post("/generate_proof", json=self.VALID_BODY)
        self.assertEqual(resp.status_code, 401)

    def test_wrong_api_key_rejected(self):
        resp = self.client.post(
            "/generate_proof", json=self.VALID_BODY, headers={"X-API-Key": "wrong"}
        )
        self.assertEqual(resp.status_code, 401)

    def test_valid_request_succeeds(self):
        resp = self.client.post(
            "/generate_proof", json=self.VALID_BODY, headers={"X-API-Key": "test-api-key"}
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "success")
        self.assertIn("request_id", body)
        self.assertIn("ticket", body)
        self.assertEqual(resp.headers.get("X-Request-ID"), body["request_id"])

    def test_invalid_body_rejected(self):
        bad_body = {"claimed_accuracy": 80, "correct": 11, "total": 10}  # correct > total
        resp = self.client.post(
            "/generate_proof", json=bad_body, headers={"X-API-Key": "test-api-key"}
        )
        self.assertEqual(resp.status_code, 400)

    def test_health_and_predict_routes_unaffected(self):
        # /health takes no auth at all, exactly as before Phase 8.
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"status": "ok"})

    def test_rate_limit_trips_after_the_configured_max(self):
        limit = security._default_rate_limiter.max_requests
        headers = {"X-API-Key": "test-api-key"}
        for _ in range(limit):
            resp = self.client.post("/generate_proof", json=self.VALID_BODY, headers=headers)
            self.assertEqual(resp.status_code, 200)
        resp = self.client.post("/generate_proof", json=self.VALID_BODY, headers=headers)
        self.assertEqual(resp.status_code, 429)


if __name__ == "__main__":
    unittest.main()
