pragma circom 2.1.6;

/*
 * PHASE 1 - toolchain sanity check.
 *
 * The statement being proved is deliberately trivial:  "I know an x such that
 * x * x == y."  The point is not the maths, it is to confirm that the whole
 * Circom -> witness -> Groth16 setup -> prove -> verify chain really works
 * before we build anything that matters on top of it.
 *
 *   x  is PRIVATE.  It never leaves the prover.  The verifier never learns it.
 *   y  is PUBLIC.   The verifier sees it and checks the proof against it.
 *
 * Note on style: y is written as a public *input* checked with `===`, rather
 * than as an output signal.  That is on purpose - it is the same shape the
 * real accuracy circuit will have later on (threshold and total public, the
 * per-sample results private), so the pattern you learn here carries forward.
 */
template Square() {
    signal input x;   // private (default in circom: inputs are private)
    signal input y;   // made public by the `main` declaration below

    // The single constraint. If y != x*x, witness generation fails outright,
    // and no proof can be produced.
    y === x * x;
}

// Everything not listed in {public [...]} stays private.
component main {public [y]} = Square();
