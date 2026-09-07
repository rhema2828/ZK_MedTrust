pragma circom 2.1.6;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "node_modules/circomlib/circuits/mux1.circom";

// Verifies a Merkle path from leaf to root using Poseidon.
template MerklePath(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];   // 0 = current node is left child, 1 = right
    signal output root;

    component hash[depth];
    component muxL[depth];
    component muxR[depth];
    signal cur[depth + 1];

    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // force pathIndices to be a bit
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

template Settlement(depth) {
    // ---- private witness: never leaves the prover ----
    signal input balance;
    signal input salt;
    signal input accountId;
    signal input blocked;               // NEW: custodian-set block flag, must be 0 or 1
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // ---- public inputs: all the verifier ever sees ----
    signal input merkleRoot;
    signal input threshold;
    signal input tradeId;

    // 0. blocked must be a bit (0 = clear, 1 = sanctioned/blocked)
    blocked * (blocked - 1) === 0;

    // 1. leaf = Poseidon(accountId, balance, salt, blocked)
    component leaf = Poseidon(4);
    leaf.inputs[0] <== accountId;
    leaf.inputs[1] <== balance;
    leaf.inputs[2] <== salt;
    leaf.inputs[3] <== blocked;

    // 2. that leaf is in the custodian-attested tree
    component mp = MerklePath(depth);
    mp.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    mp.root === merkleRoot;

    // 3. balance > threshold, without revealing balance
    component gt = GreaterThan(64);
    gt.in[0] <== balance;
    gt.in[1] <== threshold;
    gt.out === 1;

    // 4. the account must not be flagged blocked
    blocked === 0;

    // 5. bind the proof to one trade so it cannot be replayed
    signal tradeIdBound;
    tradeIdBound <== tradeId * tradeId;
}

component main {public [merkleRoot, threshold, tradeId]} = Settlement(8);
