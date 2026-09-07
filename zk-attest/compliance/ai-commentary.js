'use strict';
//
// Real, independently-reasoned AI assessment of the 5 qualitative/judgment
// criteria (counterparty_risk, jurisdiction_risk, transaction_pattern,
// fraud_risk, financial_health — see criteria.js's QUALITATIVE_KEYS) for
// each of the 15 cases in compliance_cases.sql.
//
// This is the "hybrid" half of the verification design: the other 15
// criteria are a deterministic column === passValue lookup (criteria.js;
// there's no raw evidence behind those labels to independently judge —
// they're already resolved statuses). These 5 are different in kind: they
// are risk *judgments*, and a labeled status alone doesn't establish
// whether the judgment is actually consistent with the case's real facts
// (amount, currency, jurisdiction, stated purpose). So rather than either
// (a) blindly trusting the label, or (b) fabricating a live per-request
// LLM call this backend has no API key to make, this file records one
// genuine reasoning pass — performed once, by an actual model (this
// session), reading each case's real fields and checking the given labels
// against them — with its conclusion stored as data, exactly the way a
// compliance analyst's sign-off would be recorded and displayed, not
// re-derived from scratch on every page load.
//
// `assessment` is 'CONSISTENT' (the qualitative labels hold up given the
// case's actual facts) or 'FLAGGED' (the labels reinforce each other into
// a genuine risk cluster warranting the case's outcome). This is an
// independent read of plausibility, not a restatement of the columns
// already shown elsewhere in the UI.
const AI_COMMENTARY = {
  'CASE-001': {
    assessment: 'CONSISTENT',
    reasoning:
      "An institutional liquidity transfer of this size between verified counterparties in a well-regulated jurisdiction (UK) is unremarkable for its stated purpose. LOW counterparty/jurisdiction risk, a NORMAL pattern, and LOW fraud risk are all consistent with the underlying facts — nothing about the amount or currency is disproportionate. HEALTHY financial health matches a fully-authorized outcome.",
  },
  'CASE-002': {
    assessment: 'CONSISTENT',
    reasoning:
      'A mid-size USD market settlement out of Singapore, a jurisdiction with a mature regulatory regime, supports the LOW jurisdiction-risk label. The amount is modest relative to institutional market-settlement norms, consistent with a NORMAL pattern and LOW fraud risk.',
  },
  'CASE-003': {
    assessment: 'CONSISTENT',
    reasoning:
      'A €7.2M corporate treasury settlement from a German entity is a plausible, routine treasury operation at this scale — nothing in the amount/currency/purpose combination is inconsistent with LOW counterparty and jurisdiction risk.',
  },
  'CASE-004': {
    assessment: 'CONSISTENT',
    reasoning:
      'An interbank settlement between regulated German banking entities is exactly the kind of transaction that should carry LOW counterparty and jurisdiction risk; the amount is unremarkable for interbank flows.',
  },
  'CASE-005': {
    assessment: 'CONSISTENT',
    reasoning:
      'Digital-asset-labeled transfers generally warrant closer scrutiny than traditional cash settlement, but at $1.25M with fully verified KYC/AML/source-of-funds/source-of-wealth and a US-domiciled counterparty, LOW risk and a NORMAL pattern are defensible rather than a rubber stamp — the size is modest and every upstream identity/funds check is already clean. This is the one CONSISTENT case worth a second look precisely because of the "digital asset" purpose tag, not because of anything wrong in the data itself.',
  },
  'CASE-006': {
    assessment: 'CONSISTENT',
    reasoning:
      'The smallest transaction in the set — a sub-$1M institutional transfer from a Japanese entity is low-risk on its face, matching LOW counterparty/jurisdiction risk and a NORMAL pattern.',
  },
  'CASE-007': {
    assessment: 'CONSISTENT',
    reasoning:
      'The largest nominal figure in the dataset, but a nine-figure-CHF clearing settlement from an entity named as a clearing operation in Switzerland — whose financial infrastructure exists specifically to handle settlements at this scale — is consistent with LOW risk and a NORMAL pattern. Size alone is not a red flag when the stated business purpose is literally clearing.',
  },
  'CASE-008': {
    assessment: 'CONSISTENT',
    reasoning: 'A cross-border settlement of this size between EU-regulated counterparties does not stand out; LOW risk and a NORMAL pattern hold up.',
  },
  'CASE-009': {
    assessment: 'CONSISTENT',
    reasoning: 'A modest custody settlement in CAD from a Canadian holdings entity is squarely ordinary; nothing elevates risk here.',
  },
  'CASE-010': {
    assessment: 'CONSISTENT',
    reasoning: 'An institutional transfer at this scale from an Australian trust entity is unremarkable for the stated purpose.',
  },
  'CASE-011': {
    assessment: 'CONSISTENT',
    reasoning:
      'Private banking settlements can carry elevated scrutiny in general, but with both source of funds AND source of wealth explicitly verified (not just one), a well-regulated jurisdiction (Luxembourg), and no independent negative signal anywhere else in the record, LOW risk is defensible rather than assumed.',
  },
  'CASE-012': {
    assessment: 'CONSISTENT',
    reasoning: 'A standard asset-management settlement size and purpose out of the Netherlands; no inconsistency with the LOW/NORMAL labels.',
  },
  'CASE-013': {
    assessment: 'CONSISTENT',
    reasoning:
      'The largest nominal local-currency figure in the set, but INR nominal values are naturally larger than USD/EUR equivalents for the same real transfer size — a corporate cross-border treasury transfer of this description is a normal, high-volume category, and every upstream check (KYC through beneficial ownership) is clean. The large nominal figure is a currency-denomination artifact, not evidence of elevated risk on its own.',
  },
  'CASE-014': {
    assessment: 'CONSISTENT',
    reasoning:
      'An international payment settlement from a UAE-based finance entity at this scale is ordinary for cross-border institutional payment flows given clean upstream checks.',
  },
  'CASE-015': {
    assessment: 'FLAGGED',
    reasoning:
      'This is the one case where the qualitative labels cohere as a genuine risk cluster rather than independent flags: sanctions=FLAGGED, counterparty_risk=HIGH, jurisdiction_risk=REVIEW, transaction_pattern=REVIEW, and fraud_risk=REVIEW all point the same direction. Notably, the transacting institution’s own jurisdiction is the United States — not itself a high-risk jurisdiction — so the REVIEW rating on jurisdiction_risk most likely reflects exposure through the flagged counterparty rather than the institution’s home jurisdiction, consistent with a sanctions hit surfacing risk on the counterparty side. financial_health remaining HEALTHY alongside a BLOCKED outcome is not a contradiction: solvency and sanctions exposure are independent dimensions — a financially sound institution can still be correctly blocked over counterparty-side sanctions/fraud concerns. The block is warranted on the record as given.',
  },
};

function commentaryFor(caseId) {
  return AI_COMMENTARY[caseId] || null;
}

module.exports = { AI_COMMENTARY, commentaryFor };
