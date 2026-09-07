// Client for the real ZK-Attest backend (see ../../zk-attest/API_CONTRACT.md
// in the main repo for the full, authoritative contract). Every shape here
// matches what the server actually returns — nothing here is invented, and
// there is deliberately no fallback to fabricated data if the backend is
// unreachable: a failed request is reported as a failure, not papered over
// with a fake proof that looks real.

export type GrothProof = {
  pi_a: [string, string, string]
  pi_b: [[string, string], [string, string], [string, string]]
  pi_c: [string, string, string]
  protocol: string
  curve: string
}

// publicSignals is always exactly [merkleRoot, threshold, tradeId,
// custodianPubKeyAx, custodianPubKeyAy], in that order — fixed by the
// circuit's own `component main {public [...]}` declaration.
export type PublicSignals = [string, string, string, string, string]

export type FailedAt = 'merkleRoot' | 'threshold' | 'blocked' | 'attestation' | 'unknown'

export type ProveSuccess = {
  ok: true
  proof: GrothProof
  publicSignals: PublicSignals
  proveMs: number
  constraintCount: number | null
  proofBytes: number
}

export type ProveFailure = {
  ok: false
  // true only when the request never reached the backend at all (network
  // error, backend not running) — distinct from a real 422 rejection, which
  // is an expected outcome the backend computed on purpose.
  networkError: boolean
  status: number
  error: string
  failedAt?: FailedAt
}

export type ProveResult = ProveSuccess | ProveFailure

export type Institution = {
  accountId: number
  balance: number
  blocked: 0 | 1
  name: string
  role: string
}

export type CircuitStats = {
  nonLinearConstraints: number
  linearConstraints: number
  privateInputs: number
  publicInputs: number
  source: string
  generatedAt: string
}

export type TreasuryBook = {
  institutions: Institution[]
  merkleRoot: string
  treeDepth: number
  custodianPubKey: { Ax: string; Ay: string }
  circuitStats: CircuitStats | null
}

export type ExchangeBook = {
  merkleRoot: string
  treeDepth: number
  custodianPubKey: { Ax: string; Ay: string }
  circuitStats: CircuitStats | null
}

export type TamperMode = 'blocked_account' | 'balance_mismatch' | 'merkle_mismatch'

// From GET /api/witness/:accountId — a demo-only transparency endpoint, not
// part of the proving/verification path. Reveals the full plaintext leaf
// construction (salt, leaf hash, custodian signature, Merkle path) for one
// of the 5 staged demo accounts, so the "human claim -> field elements"
// pipeline can be shown with real values instead of asserted. Safe only
// because these accounts' balances are already public via getTreasuryBook().
export type WitnessExplanation = {
  accountId: number
  name: string
  balance: number
  blocked: 0 | 1
  salt: string
  leafHash: string
  attestation: { R8x: string; R8y: string; S: string }
  pathElements: string[]
  pathIndices: number[]
  merkleRoot: string
  custodianPubKey: { Ax: string; Ay: string }
}

export type AuditLogEntry = {
  timestamp: string
  endpoint: 'prove' | 'tamper'
  accountId: number
  result: 'success' | 'rejected'
  reason: string | null
  mode?: TamperMode
}

export type AuditLog = {
  entries: AuditLogEntry[]
  count: number
  maxEntries: number
}

const API_BASE_URL = process.env.NEXT_PUBLIC_ZK_ATTEST_API_URL ?? 'http://localhost:3000'

async function postProve(path: string, body: unknown): Promise<ProveResult> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return {
      ok: false,
      networkError: true,
      status: 0,
      error: `Could not reach the ZK-Attest backend at ${API_BASE_URL}. Is it running (bash scripts/setup.sh && node server/index.js in zk-attest/)?`,
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
    constraintCount: data.constraintCount ?? null,
    proofBytes: data.proofBytes,
  }
}

export async function getTreasuryBook(): Promise<TreasuryBook> {
  const response = await fetch(`${API_BASE_URL}/api/book/treasury`)
  if (!response.ok) throw new Error(`Failed to load the treasury book (${response.status}).`)
  return response.json()
}

export async function getExchangeBook(): Promise<ExchangeBook> {
  const response = await fetch(`${API_BASE_URL}/api/book/exchange`)
  if (!response.ok) throw new Error(`Failed to load the exchange view (${response.status}).`)
  return response.json()
}

export async function generateProof(params: { accountId: number; threshold: number; tradeId: number }): Promise<ProveResult> {
  return postProve('/api/prove', params)
}

export async function verifyProof(proof: GrothProof, publicSignals: PublicSignals): Promise<{ valid: boolean; verifyMs: number } | { error: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/verify`, {
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

export async function runTamper(params: { mode: TamperMode; accountId?: number; threshold: number; tradeId: number }): Promise<ProveResult> {
  return postProve('/api/tamper', params)
}

export async function getWitnessExplanation(accountId: number): Promise<WitnessExplanation> {
  const response = await fetch(`${API_BASE_URL}/api/witness/${accountId}`)
  if (!response.ok) throw new Error(`Failed to load the witness explanation for account ${accountId} (${response.status}).`)
  return response.json()
}

export async function getAuditLog(): Promise<AuditLog> {
  const response = await fetch(`${API_BASE_URL}/api/audit-log`)
  if (!response.ok) throw new Error(`Failed to load the audit log (${response.status}).`)
  return response.json()
}
