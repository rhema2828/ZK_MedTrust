'use client'

// The compliance-verification dashboard: real 15-case × 20-criteria data,
// a live ZK proof console, a human-language-to-cryptography pipeline, and
// a live audit log — the same "don't take our word for it" pattern
// components/crypto-console.tsx established for the settlement demo,
// applied to the compliance dataset and its own circuit
// (../../zk-attest/circuits/compliance.circom).

import { useCallback, useEffect, useState } from 'react'
import { PlayCircle, RefreshCw, ShieldCheck, CircleAlert, Lock, Unlock, ChevronDown } from 'lucide-react'
import {
  getComplianceCases,
  getComplianceWitness,
  proveCompliance,
  getComplianceAuditLog,
  type ComplianceCasesResponse,
  type ComplianceCase,
  type ComplianceWitness,
  type ComplianceProveResult,
  type ComplianceAuditEntry,
  type CriterionKey,
} from '@/lib/compliance-api'

const truncate = (value: string, head = 10, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value)

// Short column headers for the 20-wide matrix -- purely presentational
// (the backend sends the full label; this is just how it's abbreviated
// on screen, with the full label always available via `title`).
const SHORT_LABEL: Record<CriterionKey, string> = {
  kyc: 'KYC',
  aml: 'AML',
  sanctions: 'SANC',
  source_of_funds: 'SOF',
  source_of_wealth: 'SOW',
  transaction_threshold: 'THR',
  transaction_purpose: 'PURP',
  account_liquidity: 'LIQ',
  counterparty_risk: 'CPTY',
  jurisdiction_risk: 'JURI',
  currency_fx: 'FX',
  transaction_pattern: 'PATT',
  fraud_risk: 'FRAUD',
  beneficial_ownership: 'BO',
  regulatory_reporting: 'REPT',
  financial_health: 'FIN',
  credit_exposure: 'CRED',
  internal_policy: 'POL',
  tax_cross_border: 'TAX',
  final_authorization: 'FINAL',
}

function Matrix({ data, selectedCaseId, onSelect }: { data: ComplianceCasesResponse; selectedCaseId: string; onSelect: (id: string) => void }) {
  return (
    <div className="compliance-matrix-wrap">
      <table className="compliance-matrix">
        <thead>
          <tr>
            <th className="matrix-case-col">CASE</th>
            {data.criteria.map((c) => (
              <th key={c.key} title={c.label}>
                {SHORT_LABEL[c.key]}
                {c.qualitative && <sup>AI</sup>}
              </th>
            ))}
            <th>SCORE</th>
          </tr>
        </thead>
        <tbody>
          {data.cases.map((c) => (
            <tr key={c.caseId} className={c.caseId === selectedCaseId ? 'selected' : ''} onClick={() => onSelect(c.caseId)}>
              <td className="matrix-case-col">
                <strong>{c.caseId}</strong>
                <span>{c.institution}</span>
              </td>
              {c.criteria.map((cr) => (
                <td key={cr.key} className={cr.pass ? 'pass' : 'fail'} title={`${cr.label}: ${cr.value}`}>
                  {cr.pass ? '✓' : '✗'}
                </td>
              ))}
              <td className={`matrix-score ${c.passCount === c.totalCriteria ? 'perfect' : 'flagged'}`}>
                {c.passCount}/{c.totalCriteria}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="matrix-legend">
        <span>
          <sup>AI</sup> = one of the 6 qualitative criteria independently reassessed by AI commentary, not just a status lookup
        </span>
      </div>
    </div>
  )
}

function CaseDetail({ caseData }: { caseData: ComplianceCase }) {
  return (
    <div className="console-card">
      <div className="console-card-head">
        <span className="eyebrow">CASE DETAIL</span>
        <h3>
          {caseData.caseId} — {caseData.institution}
        </h3>
        <p>
          {caseData.jurisdiction} · {caseData.currency} {caseData.amount.toLocaleString()} · {caseData.purpose}
        </p>
      </div>
      <div className="criteria-list">
        {caseData.criteria.map((c) => (
          <div className={`criteria-row ${c.pass ? 'pass' : 'fail'}`} key={c.key}>
            <span>{c.label}</span>
            <strong>{c.value}</strong>
          </div>
        ))}
      </div>
      {caseData.aiCommentary && (
        <div className={`ai-commentary ${caseData.aiCommentary.assessment === 'FLAGGED' ? 'flagged' : 'consistent'}`}>
          <span className="eyebrow">AI CROSS-VERIFICATION — {caseData.aiCommentary.assessment}</span>
          <p>{caseData.aiCommentary.reasoning}</p>
        </div>
      )}
    </div>
  )
}

function LiveProofConsole({ cases, selectedCaseId, onActivity }: { cases: ComplianceCase[]; selectedCaseId: string; onActivity: () => void }) {
  const [caseId, setCaseId] = useState(selectedCaseId)
  const [passThreshold, setPassThreshold] = useState(18)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ComplianceProveResult | null>(null)

  useEffect(() => setCaseId(selectedCaseId), [selectedCaseId])

  const caseData = cases.find((c) => c.caseId === caseId)

  const run = async () => {
    if (loading) return
    setLoading(true)
    setResult(null)
    const outcome = await proveCompliance({ caseId, passThreshold, proofNonce: Date.now() })
    setResult(outcome)
    setLoading(false)
    onActivity()
  }

  return (
    <div className="console-card">
      <div className="console-card-head">
        <span className="eyebrow">01 / LIVE COMPLIANCE PROOF</span>
        <h3>Prove a case clears your bar.</h3>
        <p>Pick any case and any pass-count threshold (0-20). The real circuit either proves it or genuinely refuses to.</p>
      </div>
      <div className="console-controls">
        <label>
          <span>CASE</span>
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {cases.map((c) => (
              <option key={c.caseId} value={c.caseId}>
                {c.caseId} — {c.institution}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>PASS THRESHOLD (of 20)</span>
          <input type="number" value={passThreshold} min={0} max={20} onChange={(e) => setPassThreshold(Number(e.target.value))} />
        </label>
        <button className="console-run-button" onClick={run} disabled={loading}>
          {loading ? 'Proving…' : <>Run real proof <PlayCircle size={15} /></>}
        </button>
      </div>
      {caseData && (
        <div className="console-hint">
          Real score on file: <strong>{caseData.passCount}/20</strong> criteria passed
        </div>
      )}
      {result && (
        <div className={`console-result ${result.ok ? 'ok' : 'fail'}`}>
          {result.ok ? <ShieldCheck size={16} /> : <CircleAlert size={16} />}
          <div>
            {result.ok ? (
              <>
                <strong>Real proof constructed in {result.proveMs}ms.</strong>
                <span>
                  root {truncate(result.publicSignals[0])} · threshold {result.publicSignals[1]} · nonce {truncate(result.publicSignals[2], 6, 4)}
                </span>
              </>
            ) : (
              <>
                <strong>Rejected{result.failedAt ? ` — ${result.failedAt}` : ''}.</strong>
                <span>{result.error}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Pipeline({ cases, selectedCaseId }: { cases: ComplianceCase[]; selectedCaseId: string }) {
  const [witness, setWitness] = useState<ComplianceWitness | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!selectedCaseId) return
    let cancelled = false
    setLoading(true)
    getComplianceWitness(selectedCaseId)
      .then((w) => !cancelled && setWitness(w))
      .catch(() => !cancelled && setWitness(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [selectedCaseId])

  const caseData = cases.find((c) => c.caseId === selectedCaseId)

  return (
    <div className="console-card pipeline">
      <div className="console-card-head">
        <span className="eyebrow">02 / 20 CRITERIA → CRYPTOGRAPHY</span>
        <h3>Watch a 20-check file become a proof.</h3>
        <p>Every value below is fetched live for the selected case — recomputed on demand, not staged copy.</p>
      </div>

      {loading && <p className="pipeline-loading">Fetching real witness data…</p>}

      {witness && caseData && !loading && (
        <ol className="pipeline-steps">
          <li className="pipeline-step">
            <span className="pipeline-step-num">1</span>
            <div>
              <strong>Formalize — 20 real criteria results become 20 boolean field elements</strong>
              <code>bits = [{witness.bits.join(', ')}] (private)</code>
              <p>
                Each of the 20 real status strings from the compliance database (VERIFIED, CLEAR, FLAGGED, HIGH…) collapses to a single 0/1 — the
                specific pattern never leaves this step.
              </p>
            </div>
          </li>
          <li className="pipeline-step">
            <span className="pipeline-step-num">2</span>
            <div>
              <strong>Compress — two group hashes over criteria 1-10 and 11-20</strong>
              <code>
                group1 = Poseidon(bits[0..9]) = {truncate(witness.group1)}
                <br />
                group2 = Poseidon(bits[10..19]) = {truncate(witness.group2)}
              </code>
              <p>Poseidon supports at most 16 inputs per call, so the 20 bits are pre-hashed in two halves before being folded into the leaf.</p>
            </div>
          </li>
          <li className="pipeline-step">
            <span className="pipeline-step-num">3</span>
            <div>
              <strong>Commit — leaf = Poseidon(caseIndex, salt, group1, group2)</strong>
              <code>{truncate(witness.leafHash, 14, 10)}</code>
              <p>One field element now binds the case identity and all 20 results together.</p>
            </div>
          </li>
          <li className="pipeline-step">
            <span className="pipeline-step-num">4</span>
            <div>
              <strong>Attest — EdDSA-Poseidon.sign(authorityKey, leaf)</strong>
              <code>
                R8x={truncate(witness.attestation.R8x)} · S={truncate(witness.attestation.S)}
              </code>
              <p>The compliance authority's real private key signs the leaf — a claim with no matching signature can never produce a witness.</p>
            </div>
          </li>
          <li className="pipeline-step">
            <span className="pipeline-step-num">5</span>
            <div>
              <strong>Anchor — Merkle path (depth {witness.pathElements.length}) to the committed root</strong>
              <code>
                {witness.pathElements.length} sibling hashes → root {truncate(witness.merkleRoot)}
              </code>
              <p>Proves this exact 20-result vector really sits inside the authority's published tree of all 15 cases.</p>
            </div>
          </li>
          <li className="pipeline-step">
            <span className="pipeline-step-num">6</span>
            <div>
              <strong>Constrain — sum(bits) ≥ passThreshold, evaluated inside the circuit</strong>
              <code>
                sum = {caseData.passCount} of 20 → try any threshold in the console above
              </code>
              <p>Only the pass/fail comparison result matters to the verifier — never which of the 20 specific checks passed.</p>
            </div>
          </li>
          <li className="pipeline-step pipeline-final">
            <span className="pipeline-step-num">7</span>
            <div>
              <strong>What actually crosses the boundary</strong>
              <div className="pipeline-boundary">
                <div className="boundary-col is-private">
                  <span>
                    <Lock size={12} /> STAYS PRIVATE
                  </span>
                  <ul>
                    <li>all 20 individual pass/fail bits</li>
                    <li>case identity</li>
                    <li>salt</li>
                    <li>authority signature</li>
                    <li>Merkle path</li>
                    <li>the leaf hash itself</li>
                  </ul>
                </div>
                <div className="boundary-col public">
                  <span>
                    <Unlock size={12} /> ACTUALLY TRANSMITTED
                  </span>
                  <ul>
                    <li>Merkle root</li>
                    <li>pass threshold</li>
                    <li>proof nonce</li>
                    <li>authority public key</li>
                    <li>the Groth16 proof itself</li>
                  </ul>
                </div>
              </div>
            </div>
          </li>
        </ol>
      )}
    </div>
  )
}

function AuditLogPanel({ refreshSignal }: { refreshSignal: number }) {
  const [log, setLog] = useState<ComplianceAuditEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getComplianceAuditLog()
      .then((data) => setLog(data.entries.slice(-12).reverse()))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  return (
    <div className="console-card audit-card">
      <div className="console-card-head row">
        <div>
          <span className="eyebrow">03 / LIVE AUDIT LOG</span>
          <h3>Every real compliance proof attempt, persisted to disk.</h3>
        </div>
        <button className="refresh-button" onClick={load} aria-label="Refresh audit log">
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      <p>
        Pulled from <code>GET /api/compliance/audit-log</code> (<code>build/compliance-audit-log.jsonl</code>) — persists across restarts.
      </p>
      <div className="audit-table">
        <div className="audit-row audit-head">
          <span>TIME</span>
          <span>CASE</span>
          <span>THRESHOLD</span>
          <span>RESULT</span>
          <span>REASON</span>
        </div>
        {log.length === 0 && <div className="audit-empty">No proofs generated yet — run one above.</div>}
        {log.map((e, i) => (
          <div className={`audit-row ${e.result}`} key={`${e.timestamp}-${i}`}>
            <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
            <span>{e.caseId}</span>
            <span>{e.passThreshold}/20</span>
            <span>{e.result}</span>
            <span>{e.reason ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ComplianceDashboard() {
  const [data, setData] = useState<ComplianceCasesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedCaseId, setSelectedCaseId] = useState('CASE-001')
  const [auditTick, setAuditTick] = useState(0)

  useEffect(() => {
    getComplianceCases()
      .then(setData)
      .catch((e) => setError(String(e.message || e)))
  }, [])

  if (error) {
    return (
      <div className="compliance-error">
        <CircleAlert size={18} />
        <span>{error} — is the ZK-Attest backend running (node server/index.js in zk-attest/)?</span>
      </div>
    )
  }

  if (!data) return <div className="compliance-loading">Loading real compliance data…</div>

  const selectedCase = data.cases.find((c) => c.caseId === selectedCaseId) ?? data.cases[0]

  return (
    <>
      <section className="compliance-overview scene">
        <div className="section-intro">
          <p className="eyebrow">COMPLIANCE VERIFICATION</p>
          <h2>
            15 real cases.
            <br />
            <em>20 real criteria each.</em>
          </h2>
          <p className="console-lede">
            Every case below was screened against all 20 criteria in the brief — identity/KYC through final authorization. 14 clear every check;
            one is genuinely blocked. Nothing here is staged: the pass/fail matrix is a live read of the actual dataset, and every proof below is
            real Groth16 cryptography running against it.
          </p>
        </div>
        <div className="compliance-stats">
          <div>
            <small>Cases loaded</small>
            <strong>{data.cases.length}</strong>
          </div>
          <div>
            <small>Criteria per case</small>
            <strong>{data.circuit.numCriteria}</strong>
          </div>
          <div>
            <small>Cases fully clear</small>
            <strong>{data.cases.filter((c) => c.passCount === c.totalCriteria).length}</strong>
          </div>
          <div>
            <small>Merkle root</small>
            <strong className="mono">{truncate(data.merkleRoot)}</strong>
          </div>
        </div>
      </section>

      <section className="compliance-matrix-section scene" id="matrix">
        <Matrix data={data} selectedCaseId={selectedCase.caseId} onSelect={setSelectedCaseId} />
        <CaseDetail caseData={selectedCase} />
      </section>

      <section className="compliance-console scene" id="console">
        <div className="console-grid">
          <LiveProofConsole cases={data.cases} selectedCaseId={selectedCase.caseId} onActivity={() => setAuditTick((t) => t + 1)} />
          <Pipeline cases={data.cases} selectedCaseId={selectedCase.caseId} />
        </div>
        <AuditLogPanel refreshSignal={auditTick} />
      </section>
    </>
  )
}
