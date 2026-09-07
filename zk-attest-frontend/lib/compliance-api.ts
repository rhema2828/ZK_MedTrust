// Client for the real ZK-Attest compliance-verification backend (see
// ../../zk-attest/compliance/ and server/compliance-routes.js). Same
// no-fake-fallback rule as lib/zk-attest-api.ts: a failed request is
// reported as a failure, never papered over with fabricated data.

import type { GrothProof, PublicSignals } from './zk-attest-api'

export type CriterionKey =
  | 'kyc'
  | 'aml'
  | 'sanctions'
  | 'source_of_funds'
  | 'source_of_wealth'
  | 'transaction_threshold'
  | 'transaction_purpose'
  | 'account_liquidity'
  | 'counterparty_risk'
  | 'jurisdiction_risk'
  | 'currency_fx'
  | 'transaction_pattern'
  | 'fraud_risk'
  | 'beneficial_ownership'
  | 'regulatory_reporting'
  | 'financial_health'
  | 'credit_exposure'
  | 'internal_policy'
  | 'tax_cross_border'
  | 'final_authorization'

export type CriterionDef = { key: CriterionKey; label: string; qualitative: boolean }

export type CriterionResult = { key: CriterionKey; label: string; value: string; pass: boolean }

export type AiCommentary = { assessment: 'CONSISTENT' | 'FLAGGED'; reasoning: string }

export type ComplianceCase = {
  caseId: string
  institution: string
  jurisdiction: string
  amount: number
  currency: string
  purpose: string
  criteria: CriterionResult[]
  passCount: number
  totalCriteria: number
  aiCommentary: AiCommentary | null
}

export type ComplianceCasesResponse = {
  criteria: CriterionDef[]
  cases: ComplianceCase[]
  merkleRoot: string
  authorityPubKey: { Ax: string; Ay: string }
  circuit: { name: string; numCriteria: number }
}

export type ComplianceWitness = {
  caseId: string
  caseIndex: number
  bits: number[]
  salt: string
  group1: string
  group2: string
  leafHash: string
  attestation: { R8x: string; R8y: string; S: string }
  pathElements: string[]
  pathIndices: number[]
  merkleRoot: string
  authorityPubKey: { Ax: string; Ay: string }
}

export type ComplianceProveSuccess = {
  ok: true
  proof: GrothProof
  publicSignals: PublicSignals
  proveMs: number
  proofBytes: number
  numCriteria: number
}

export type ComplianceProveFailure = {
  ok: false
  networkError: boolean
  status: number
  error: string
  failedAt?: 'merkleRoot' | 'threshold' | 'attestation' | 'invalidInput' | 'unknown'
}

export type ComplianceProveResult = ComplianceProveSuccess | ComplianceProveFailure

export type ComplianceAuditEntry = {
  timestamp: string
  endpoint: 'prove'
  caseId: string
  passThreshold: number
  result: 'success' | 'rejected'
  reason: string | null
}

export type ComplianceAuditLog = { entries: ComplianceAuditEntry[]; count: number; maxEntries: number }

const API_BASE_URL = process.env.NEXT_PUBLIC_ZK_ATTEST_API_URL ?? 'http://localhost:3000'

export async function getComplianceCases(): Promise<ComplianceCasesResponse> {
  const response = await fetch(`${API_BASE_URL}/api/compliance/cases`)
  if (!response.ok) throw new Error(`Failed to load compliance cases (${response.status}).`)
  return response.json()
}

export async function getComplianceCase(caseId: string): Promise<ComplianceCase> {
  const response = await fetch(`${API_BASE_URL}/api/compliance/cases/${encodeURIComponent(caseId)}`)
  if (!response.ok) throw new Error(`Failed to load case ${caseId} (${response.status}).`)
  return response.json()
}

export async function getComplianceWitness(caseId: string): Promise<ComplianceWitness> {
  const response = await fetch(`${API_BASE_URL}/api/compliance/witness/${encodeURIComponent(caseId)}`)
  if (!response.ok) throw new Error(`Failed to load the witness explanation for ${caseId} (${response.status}).`)
  return response.json()
}

export async function proveCompliance(params: { caseId: string; passThreshold: number; proofNonce: number }): Promise<ComplianceProveResult> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/api/compliance/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return {
      ok: false,
      networkError: true,
      status: 0,
      error: `Could not reach the ZK-Attest backend at ${API_BASE_URL}.`,
    }
  }

  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    return {
      ok: false,
      networkError: false,
      status: response.status,
      error: typeof data.error === 'string' ? data.error : `Request failed (${response.status}).`,
      failedAt: data.failedAt,
    }
  }

  return {
    ok: true,
    proof: data.proof,
    publicSignals: data.publicSignals,
    proveMs: data.proveMs,
    proofBytes: data.proofBytes,
    numCriteria: data.numCriteria,
  }
}

export async function verifyCompliance(
  proof: GrothProof,
  publicSignals: PublicSignals,
): Promise<{ valid: boolean; verifyMs: number } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/compliance/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof, publicSignals }),
      signal: AbortSignal.timeout(10_000),
    })
    return await response.json()
  } catch {
    return { error: `Could not reach the ZK-Attest backend at ${API_BASE_URL}.` }
  }
}

export async function getComplianceAuditLog(): Promise<ComplianceAuditLog> {
  const response = await fetch(`${API_BASE_URL}/api/compliance/audit-log`)
  if (!response.ok) throw new Error(`Failed to load the compliance audit log (${response.status}).`)
  return response.json()
}
