/*
 * PHASE 2 - record canonicalization.
 *
 * "Canonicalization" means: turn an evaluation record into ONE fixed byte
 * string, no matter how it was typed in or in what key order it arrived, so
 * that hashing it is unambiguous and reproducible.
 *
 * An evaluation record represents one (image, ground-truth label) pair that
 * will later be fed to the existing MedicalDiagnosticsModel (Phase 4). At
 * commitment time we do not need the image bytes themselves here - the
 * caller (Phase 4) is responsible for hashing the actual image file with
 * SHA-256 and passing that digest in as `image_sha256`. That keeps this
 * module dependency-free of any image/ML tooling and keeps the commitment
 * bound to image CONTENT, not a file path (a path can be repointed at a
 * different file after the fact; a content hash cannot be forged that way).
 *
 * REQUIRED FIELDS (exactly these, nothing implicit):
 *   record_id      string   - a unique identifier for this record within the dataset
 *   image_sha256   string   - lowercase hex SHA-256 of the raw image bytes (64 chars)
 *   ground_truth   string   - "Normal" or "Abnormal" (matches ml_inference.CLASSES)
 *   dataset_version string  - a label for which dataset/version this record belongs to
 *
 * CANONICAL FORM:
 *   the exact pipe-delimited string
 *     `${record_id}|${image_sha256}|${ground_truth_code}|${dataset_version}`
 *   where ground_truth_code is "0" for Normal and "1" for Abnormal (numeric,
 *   unambiguous, matches the class index ml_inference.py already uses).
 *
 *   No JSON, no key ordering questions, no whitespace, no numeric formatting
 *   ambiguity (floats, exponents, -0 etc. never enter the picture) - every
 *   field is a plain string and the delimiter is fixed. This is deliberately
 *   the simplest thing that is still unambiguous, so it stays explainable.
 *
 * A record missing a field, with an unrecognised ground_truth, or with a
 * malformed image_sha256 is rejected outright - we never silently hash
 * incomplete or malformed data into a commitment.
 */

const REQUIRED_FIELDS = ["record_id", "image_sha256", "ground_truth", "dataset_version"];
const GROUND_TRUTH_CODE = { Normal: "0", Abnormal: "1" };
const HEX64 = /^[0-9a-f]{64}$/;

export function canonicalizeRecord(record) {
  if (record === null || typeof record !== "object") {
    throw new TypeError("record must be an object");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      throw new Error(`record is missing required field "${field}": ${JSON.stringify(record)}`);
    }
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error(`record field "${field}" must be a non-empty string: ${JSON.stringify(record)}`);
    }
  }

  const extra = Object.keys(record).filter((k) => !REQUIRED_FIELDS.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `record has unexpected field(s) ${JSON.stringify(extra)} - only ` +
      `${JSON.stringify(REQUIRED_FIELDS)} are part of the commitment. If a new ` +
      `field is genuinely needed, add it to REQUIRED_FIELDS deliberately so the ` +
      `canonical form (and every root computed before the change) is understood ` +
      `to change with it.`
    );
  }

  const code = GROUND_TRUTH_CODE[record.ground_truth];
  if (code === undefined) {
    throw new Error(
      `record.ground_truth must be "Normal" or "Abnormal", got ${JSON.stringify(record.ground_truth)}`
    );
  }

  if (!HEX64.test(record.image_sha256)) {
    throw new Error(
      `record.image_sha256 must be 64 lowercase hex characters (a SHA-256 digest), ` +
      `got ${JSON.stringify(record.image_sha256)}`
    );
  }

  return `${record.record_id}|${record.image_sha256}|${code}|${record.dataset_version}`;
}
