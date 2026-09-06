pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// Proves the claim "accuracy >= threshold%" -- i.e.
//
//     correct_predictions * SCALE >= threshold * total_predictions
//
// (SCALE = 100) -- without revealing exactly how many predictions were
// correct. This is a THRESHOLD proof, not an equality proof: it does not
// leak the exact accuracy, only that it clears the claimed bar.
//
// PUBLIC INPUTS
//   total_predictions - the evaluation sample size. Public because it is
//     already public: it comes from Phase 3's cryptographically bound
//     sampling (zk/sampling/), whose sample_size is itself public. Making
//     it private here would let a prover claim an arbitrarily small
//     total_predictions (e.g. 1) to trivially satisfy any threshold,
//     which would break the whole point of the proof.
//   threshold - the claimed minimum accuracy percentage (0-100). Public
//     because it IS the claim being verified; a verifier who doesn't know
//     what threshold was met can't check anything.
//
// PRIVATE INPUT
//   correct_predictions - how many of total_predictions were correct.
//     Private so the exact count (and by extension the exact per-record
//     pass/fail pattern of the evaluation) is not revealed. Documented
//     limitation: when total_predictions is small, there are only
//     total_predictions+1 possible values for correct_predictions, so
//     "private" narrows the search space rather than hiding it perfectly
//     -- an inherent property of this scheme at small sample sizes, not a
//     bug in the circuit.
//
// BOUND: every value is explicitly range-checked to fit in BITS bits
// before being fed to a circomlib comparator. circomlib's LessThan(n)
// (and everything built on it: LessEqThan/GreaterThan/GreaterEqThan) is
// only sound when both compared values are already known to fit in n
// bits -- it internally computes `in[0] + 2^n - in[1]` and decomposes
// that into n+1 bits, which an out-of-range operand (e.g. a private input
// wrapped around the field's modulus) can satisfy without the comparison
// meaning what it looks like it means. Skipping this step is a known
// circom footgun, not a hypothetical one.
template AccuracyThreshold(BITS) {
    signal input correct_predictions;   // private
    signal input total_predictions;     // public
    signal input threshold;             // public

    signal output valid;

    var SCALE = 100;

    // --- range checks: force every value to actually fit in BITS bits ---
    component correctBits = Num2Bits(BITS);
    correctBits.in <== correct_predictions;

    component totalBits = Num2Bits(BITS);
    totalBits.in <== total_predictions;

    component threshBits = Num2Bits(BITS);
    threshBits.in <== threshold;

    // --- 0 < total_predictions ---
    component totalPositive = GreaterThan(BITS);
    totalPositive.in[0] <== total_predictions;
    totalPositive.in[1] <== 0;
    totalPositive.out === 1;

    // --- 0 <= correct_predictions <= total_predictions ---
    component correctLeTotal = LessEqThan(BITS);
    correctLeTotal.in[0] <== correct_predictions;
    correctLeTotal.in[1] <== total_predictions;
    correctLeTotal.out === 1;

    // --- 0 <= threshold <= SCALE ---
    component threshLeScale = LessEqThan(BITS);
    threshLeScale.in[0] <== threshold;
    threshLeScale.in[1] <== SCALE;
    threshLeScale.out === 1;

    // --- the actual threshold claim ---
    // Both products are bounded by (2^BITS - 1) * 100, which needs
    // BITS + 7 bits of headroom (100 < 2^7). A wider comparator is used
    // here only because the *values being compared* are wider, not
    // because the range-check discipline above changes.
    signal lhs;
    signal rhs;
    lhs <== correct_predictions * SCALE;
    rhs <== threshold * total_predictions;

    component accuracyOk = GreaterEqThan(BITS + 7);
    accuracyOk.in[0] <== lhs;
    accuracyOk.in[1] <== rhs;
    accuracyOk.out === 1;

    valid <== 1;
}

component main {public [total_predictions, threshold]} = AccuracyThreshold(32);
