-- ============================================================
-- ZK-Attest Mock Compliance Dataset
-- Schema + seed data generated from provided case records
-- ============================================================

DROP TABLE IF EXISTS compliance_cases;

CREATE TABLE compliance_cases (
    case_id                 VARCHAR(20)     PRIMARY KEY,
    institution             VARCHAR(100)    NOT NULL,
    jurisdiction            VARCHAR(50)     NOT NULL,

    -- transaction
    amount                  DECIMAL(18,2)   NOT NULL,
    currency                VARCHAR(10)     NOT NULL,
    purpose                 VARCHAR(100),

    -- compliance checks
    kyc                     VARCHAR(20),
    aml                     VARCHAR(20),
    sanctions               VARCHAR(20),
    source_of_funds         VARCHAR(20),
    source_of_wealth        VARCHAR(20),
    transaction_threshold   VARCHAR(20),
    transaction_purpose     VARCHAR(20),
    account_liquidity       VARCHAR(20),
    counterparty_risk       VARCHAR(20),
    jurisdiction_risk       VARCHAR(20),
    currency_fx             VARCHAR(20),
    transaction_pattern     VARCHAR(20),
    fraud_risk               VARCHAR(20),
    beneficial_ownership    VARCHAR(20),
    regulatory_reporting    VARCHAR(20),
    financial_health        VARCHAR(20),
    credit_exposure         VARCHAR(20),
    internal_policy         VARCHAR(20),
    tax_cross_border        VARCHAR(20),
    final_authorization     VARCHAR(20)
);

INSERT INTO compliance_cases (
    case_id, institution, jurisdiction,
    amount, currency, purpose,
    kyc, aml, sanctions, source_of_funds, source_of_wealth,
    transaction_threshold, transaction_purpose, account_liquidity,
    counterparty_risk, jurisdiction_risk, currency_fx, transaction_pattern,
    fraud_risk, beneficial_ownership, regulatory_reporting, financial_health,
    credit_exposure, internal_policy, tax_cross_border, final_authorization
) VALUES
('CASE-001', 'Northstar Capital', 'United Kingdom',
    4850000.00, 'USD', 'Institutional liquidity transfer',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-002', 'Asterion Markets', 'Singapore',
    2150000.00, 'USD', 'Market settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-003', 'Meridian Treasury', 'Germany',
    7200000.00, 'EUR', 'Corporate treasury settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-004', 'Helix Bank AG', 'Germany',
    3100000.00, 'EUR', 'Interbank settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-005', 'Bluehaven Investments', 'United States',
    1250000.00, 'USD', 'Digital asset liquidity transfer',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-006', 'Pacific Ledger', 'Japan',
    890000.00, 'USD', 'Institutional asset transfer',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-007', 'Atlas Clearing', 'Switzerland',
    9400000.00, 'CHF', 'Clearing settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-008', 'Vector Finance', 'France',
    5600000.00, 'EUR', 'Cross-border settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-009', 'Cedar Ridge Holdings', 'Canada',
    1750000.00, 'CAD', 'Custody settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-010', 'Summit Trust', 'Australia',
    2300000.00, 'AUD', 'Institutional transfer',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-011', 'Orion Private Bank', 'Luxembourg',
    6800000.00, 'EUR', 'Private banking settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-012', 'Lattice Asset Group', 'Netherlands',
    4100000.00, 'EUR', 'Asset management settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-013', 'Redwood Treasury', 'India',
    150000000.00, 'INR', 'Cross-border treasury transfer',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-014', 'Crescent Finance', 'United Arab Emirates',
    3700000.00, 'AED', 'International payment settlement',
    'VERIFIED', 'CLEAR', 'CLEAR', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'LOW', 'LOW', 'PASS', 'NORMAL',
    'LOW', 'VERIFIED', 'COMPLIANT', 'HEALTHY',
    'WITHIN_LIMIT', 'PASS', 'PASS', 'AUTHORIZED'),

('CASE-015', 'Granite Institutional', 'United States',
    2750000.00, 'USD', 'Institutional transfer',
    'VERIFIED', 'CLEAR', 'FLAGGED', 'VERIFIED', 'VERIFIED',
    'PASS', 'VALID', 'SUFFICIENT',
    'HIGH', 'REVIEW', 'PASS', 'REVIEW',
    'REVIEW', 'VERIFIED', 'REQUIRED', 'HEALTHY',
    'WITHIN_LIMIT', 'FAIL', 'REVIEW', 'BLOCKED');
