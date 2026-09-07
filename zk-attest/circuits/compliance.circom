pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/mux1.circom";
include "node_modules/circomlib/circuits/eddsaposeidon.circom";

// Same Merkle-path verifier as settlement.circom (Poseidon(2) per level,
// Mux1-selected left/right child by pathIndices bit) — duplicated here
// rather than shared via a common include because these two circuits are
// compiled independently and this project keeps each circuit's full
// constraint set self-contained and readable on its own, the same
// tradeoff settlement.circom already made over factoring out a shared file.
template MerklePath(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hash[depth];
    component muxL[depth];
    component muxR[depth];
    signal cur[depth + 1];

    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        muxL[i] = Mux1();
        muxL[i].c[0] <== cur[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== cur[i];
        muxR[i].s <== pathIndices[i];

        hash[i] = Poseidon(2);
        hash[i].inputs[0] <== muxL[i].out;
        hash[i].inputs[1] <== muxR[i].out;
        cur[i + 1] <== hash[i].out;
    }

    root <== cur[depth];
}

// Proves "at least `passThreshold` of this case's NUM_CRITERIA compliance
// checks passed" — a threshold claim over a real 20-entry check vector,
// without revealing the vector itself (which of the 20 passed/failed),
// the case's identity, or which case among the committed set this is.
//
// Design deliberately mirrors two circuits already in this repo rather
// than inventing new patterns:
//   - the leaf-commitment / custodian-attestation / Merkle-membership
//     structure is settlement.circom's (circuits/settlement.circom),
//     applied to a compliance case instead of a treasury account;
//   - the range-checked threshold comparison is
//     ../../zk/circuits/accuracy.circom's AccuracyThreshold pattern
//     (correct_predictions*100 >= threshold*total_predictions), applied
//     to a sum-of-booleans instead of a prediction count.
//
// NUM_CRITERIA (20) is a circuit-structural constant, not a public
// signal: it's fixed by the compliance dataset's actual schema
// (compliance/criteria.js has exactly 20 entries), not a claim being
// proven, so unlike passThreshold it doesn't belong in the public inputs.
template ComplianceThreshold(depth, numCriteria, groupSize) {
    // ---- private witness: never leaves the prover ----
    signal input caseIndex;              // which committed case (1-15) — kept
                                          // private the same way settlement.circom
                                          // keeps accountId private.
    signal input bits[numCriteria];      // the 20 real pass(1)/fail(0) flags
    signal input salt;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Compliance-authority attestation over this exact leaf — same trust
    // model as settlement.circom's custodian signature: a bit vector with
    // no matching authority signature cannot produce a witness at all.
    signal input attestationR8x;
    signal input attestationR8y;
    signal input attestationS;

    // ---- public inputs: all the verifier ever sees ----
    signal input merkleRoot;
    signal input passThreshold;   // e.g. 18 -- "at least 18 of 20 must pass"
    signal input proofNonce;      // binds the proof to one verification request
    signal input authorityPubKeyAx;
    signal input authorityPubKeyAy;

    // 0. every bit must actually be a bit.
    for (var i = 0; i < numCriteria; i++) {
        bits[i] * (bits[i] - 1) === 0;
    }

    // 1. leaf = Poseidon(caseIndex, salt, group1, group2), where
    //    group1/group2 are Poseidon(groupSize) over the first/second half
    //    of `bits` -- see build-compliance-tree.js for why the 20 bits
    //    are pre-hashed in two groups rather than passed to one Poseidon
    //    call (circomlib's Poseidon template supports at most 16 inputs).
    component group1 = Poseidon(groupSize);
    component group2 = Poseidon(groupSize);
    for (var i = 0; i < groupSize; i++) {
        group1.inputs[i] <== bits[i];
        group2.inputs[i] <== bits[groupSize + i];
    }

    component leaf = Poseidon(4);
    leaf.inputs[0] <== caseIndex;
    leaf.inputs[1] <== salt;
    leaf.inputs[2] <== group1.out;
    leaf.inputs[3] <== group2.out;

    // 1b. the leaf must carry a valid compliance-authority signature.
    component sigVerifier = EdDSAPoseidonVerifier();
    sigVerifier.enabled <== 1;
    sigVerifier.Ax <== authorityPubKeyAx;
    sigVerifier.Ay <== authorityPubKeyAy;
    sigVerifier.R8x <== attestationR8x;
    sigVerifier.R8y <== attestationR8y;
    sigVerifier.S <== attestationS;
    sigVerifier.M <== leaf.out;

    // 2. that leaf is in the authority-attested tree of committed cases.
    component mp = MerklePath(depth);
    mp.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    mp.root === merkleRoot;

    // 3. sum the 20 booleans -- a plain linear combination, not a
    //    comparator, so no range check is needed on the sum itself
    //    beyond what step 0 already guarantees (each term is 0 or 1, so
    //    the sum is trivially in [0, numCriteria], far inside the field).
    signal passCount;
    var acc = 0;
    for (var i = 0; i < numCriteria; i++) {
        acc += bits[i];
    }
    passCount <== acc;

    // 4. range-check passThreshold before comparing it -- same discipline
    //    AccuracyThreshold uses: circomlib's GreaterEqThan/LessEqThan are
    //    only sound once both operands are known to fit in BITS bits.
    component threshBits = Num2Bits(8);
    threshBits.in <== passThreshold;

    component threshInRange = LessEqThan(8);
    threshInRange.in[0] <== passThreshold;
    threshInRange.in[1] <== numCriteria;
    threshInRange.out === 1;

    // 5. the actual threshold claim: passCount >= passThreshold.
    component ok = GreaterEqThan(8);
    ok.in[0] <== passCount;
    ok.in[1] <== passThreshold;
    ok.out === 1;

    // 6. bind the proof to one verification request so it cannot be
    //    replayed to answer a different request (same tradeId-binding
    //    idiom settlement.circom uses).
    signal proofNonceBound;
    proofNonceBound <== proofNonce * proofNonce;
}

component main {public [merkleRoot, passThreshold, proofNonce, authorityPubKeyAx, authorityPubKeyAy]} = ComplianceThreshold(4, 20, 10);
