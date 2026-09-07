'use strict';
//
// The 20 compliance criteria, in the exact order given in the brief, mapped
// to the corresponding column in compliance_cases.sql and the value that
// column must equal for that criterion to PASS. Every other value present
// in the real dataset (FLAGGED, HIGH, REVIEW, REQUIRED, FAIL, BLOCKED) is a
// FAIL — this is a closed classification (column === passValue), not an
// allowlist/denylist heuristic, so it can't silently misclassify a status
// string it's never seen before as a pass.
//
// This ordering is also the bit order used everywhere downstream: the
// Merkle leaf's 20 boolean signals (build-compliance-tree.js), the
// witness's `bits` array (circuits/compliance.circom), and the frontend's
// criteria matrix columns all iterate CRITERIA in this exact order.
const CRITERIA = [
  { key: 'kyc', column: 'kyc', label: 'Identity / KYC verification', passValue: 'VERIFIED' },
  { key: 'aml', column: 'aml', label: 'AML (Anti-Money Laundering) screening', passValue: 'CLEAR' },
  { key: 'sanctions', column: 'sanctions', label: 'Sanctions screening', passValue: 'CLEAR' },
  { key: 'source_of_funds', column: 'source_of_funds', label: 'Source of funds verification', passValue: 'VERIFIED' },
  { key: 'source_of_wealth', column: 'source_of_wealth', label: 'Source of wealth verification', passValue: 'VERIFIED' },
  { key: 'transaction_threshold', column: 'transaction_threshold', label: 'Transaction amount and regulatory thresholds', passValue: 'PASS' },
  { key: 'transaction_purpose', column: 'transaction_purpose', label: 'Transaction purpose verification', passValue: 'VALID' },
  { key: 'account_liquidity', column: 'account_liquidity', label: 'Account balance / liquidity', passValue: 'SUFFICIENT' },
  { key: 'counterparty_risk', column: 'counterparty_risk', label: 'Counterparty risk assessment', passValue: 'LOW', qualitative: true },
  { key: 'jurisdiction_risk', column: 'jurisdiction_risk', label: 'Country / jurisdiction risk', passValue: 'LOW', qualitative: true },
  { key: 'currency_fx', column: 'currency_fx', label: 'Currency and FX compliance', passValue: 'PASS' },
  { key: 'transaction_pattern', column: 'transaction_pattern', label: 'Transaction pattern / unusual activity detection', passValue: 'NORMAL', qualitative: true },
  { key: 'fraud_risk', column: 'fraud_risk', label: 'Fraud risk assessment', passValue: 'LOW', qualitative: true },
  { key: 'beneficial_ownership', column: 'beneficial_ownership', label: 'Beneficial ownership verification', passValue: 'VERIFIED' },
  { key: 'regulatory_reporting', column: 'regulatory_reporting', label: 'Regulatory reporting requirements', passValue: 'COMPLIANT' },
  { key: 'financial_health', column: 'financial_health', label: 'Financial health / solvency', passValue: 'HEALTHY', qualitative: true },
  { key: 'credit_exposure', column: 'credit_exposure', label: 'Credit exposure and limits', passValue: 'WITHIN_LIMIT' },
  { key: 'internal_policy', column: 'internal_policy', label: 'Internal compliance policy checks', passValue: 'PASS' },
  { key: 'tax_cross_border', column: 'tax_cross_border', label: 'Tax and cross-border reporting requirements', passValue: 'PASS' },
  { key: 'final_authorization', column: 'final_authorization', label: 'Final transaction authorization / settlement approval', passValue: 'AUTHORIZED' },
];

const NUM_CRITERIA = CRITERIA.length; // 20

// The 6 criteria marked `qualitative: true` above are risk/judgment calls
// rather than a document-verified/list-lookup status — for these, the
// dataset's label is corroborated (not overridden) by a real, independently
// reasoned AI assessment of whether the label is plausible given the case's
// actual amount/currency/jurisdiction/purpose. See generate-ai-commentary.js.
const QUALITATIVE_KEYS = CRITERIA.filter((c) => c.qualitative).map((c) => c.key);

// bits[i] = 1 if row[CRITERIA[i].column] === CRITERIA[i].passValue, else 0.
// Throws on an unrecognized/missing status value rather than silently
// defaulting it to fail or pass, so a schema drift in a future case file
// is caught immediately instead of producing a quietly-wrong bit vector.
function bitsFor(row) {
  return CRITERIA.map(({ column, passValue }) => {
    const value = row[column];
    if (value === undefined || value === null || value === '') {
      throw new Error(`compliance_cases row ${row.case_id}: column "${column}" is missing a value.`);
    }
    return value === passValue ? 1 : 0;
  });
}

function passCount(row) {
  return bitsFor(row).reduce((a, b) => a + b, 0);
}

module.exports = { CRITERIA, NUM_CRITERIA, QUALITATIVE_KEYS, bitsFor, passCount };
