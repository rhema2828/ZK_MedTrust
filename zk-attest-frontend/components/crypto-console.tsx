'use client'

// The "don't take our word for it" section. Three parts, all wired to the
// real ZK-Attest backend with no fallback/fake data:
//
// 1. LiveConsole — lets the visitor pick ANY account and ANY threshold
//    (not just the two demo accounts the Settlement section above cycles
//    between) and generates a real proof against it, live.
// 2. Pipeline — walks one account's real leaf construction (fetched from
//    the demo-only GET /api/witness/:accountId transparency endpoint) step
//    by step, turning a plain-English claim into the actual field elements
//    a real proof is built from — every value shown is fetched/recomputed
//    for whichever account is selected, not staged copy.
// 3. AuditLogPanel — shows the real, persisted (build/audit-log.jsonl)
//    history of every /api/prove and /api/tamper call, refreshed on demand
//    and automatically whenever this section or the main Settlement panel
//    does something.

import { useCallback, useEffect, useState } from 'react'
import { PlayCircle, RefreshCw, ShieldCheck, CircleAlert, Lock, Unlock } from 'lucide-react'
import {
  generateProof,
  getWitnessExplanation,
  getAuditLog,
  type Institution,
  type TreasuryBook,
  type ProveResult,
  type WitnessExplanation,
  type AuditLogEntry,
} from '@/lib/zk-attest-api'

const truncate = (value: string, head = 10, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value)
const DEMO_THRESHOLD = 1_000_000

function LiveConsole({ institutions, onActivity }: { institutions: Institution[]; onActivity: () => void }) {
  const [accountId, setAccountId] = useState<number>(institutions[0]?.accountId ?? 0)
  const [threshold, setThreshold] = useState<number>(DEMO_THRESHOLD)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ProveResult | null>(null)

  const account = institutions.find((i) => i.accountId === accountId)

  const run = async () => {
    if (loading) return
    setLoading(true)
    setResult(null)
    const outcome = await generateProof({ accountId, threshold, tradeId: Date.now() })
    setResult(outcome)
    setLoading(false)
    onActivity()
  }

  return (
    <div className="console-card">
      <div className="console-card-head">
        <span className="eyebrow">01 / LIVE VERIFICATION</span>
        <h3>Pick your own numbers.</h3>
        <p>Not the two scripted demo accounts above — choose any account and any threshold. The real backend proves it, or genuinely refuses to, right now.</p>
      </div>
      <div className="console-controls">
        <label>
          <span>ACCOUNT</span>
          <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
            {institutions.map((i) => (
              <option key={i.accountId} value={i.accountId}>
                {i.accountId} — {i.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>THRESHOLD ($)</span>
          <input type="number" value={threshold} min={0} step={50000} onChange={(e) => setThreshold(Number(e.target.value))} />
        </label>
        <button className="console-run-button" onClick={run} disabled={loading}>
          {loading ? 'Proving…' : <>Run real proof <PlayCircle size={15} /></>}
        </button>
      </div>
      {account && (
        <div className="console-hint">
          Real balance on file: <strong>${account.balance.toLocaleString()}</strong> · block status:{' '}
          <strong>{account.blocked ? 'FLAGGED' : 'CLEAR'}</strong>
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
                  root {truncate(result.publicSignals[0])} · threshold {result.publicSignals[1]} · tradeId {result.publicSignals[2]}
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

function Pipeline({ institutions }: { institutions: Institution[] }) {
  const [accountId, setAccountId] = useState<number>(institutions[0]?.accountId ?? 0)
  const [witness, setWitness] = useState<WitnessExplanation | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setLoading(true)
    getWitnessExplanation(accountId)
      .then((w) => !cancelled && setWitness(w))
      .catch(() => !cancelled && setWitness(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [accountId])

  const account = institutions.find((i) => i.accountId === accountId)
  const clearsThreshold = account ? account.balance > DEMO_THRESHOLD : null
  const isBlocked = witness ? witness.blocked === 1 : null
  const wouldProve = clearsThreshold !== null && isBlocked !== null ? clearsThreshold && !isBlocked : null

  return (
    <div className="console-card pipeline">
      <div className="console-card-head">
        <span className="eyebrow">02 / HUMAN LANGUAGE → CRYPTOGRAPHY</span>
        <h3>Watch one claim become a proof.</h3>
        <p>Every value below is fetched live from the real backend for whichever account is selected — recomputed on demand, not staged copy.</p>
      </div>
      <select className="pipeline-select" value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
        {institutions.map((i) => (
          <option key={i.accountId} value={i.accountId}>
            {i.accountId} — {i.name}
          </option>
        ))}
      </select>

      {loading && <p className="pipeline-loading">Fetching real witness data…</p>}

      {witness && account && !loading && (
        <>
          <blockquote className="pipeline-claim">
            Claim under test: “Does {account.name}'s balance exceed ${DEMO_THRESHOLD.toLocaleString()}, per the custodian's own signed record,
            with the account not blocked?”
          </blockquote>

          <ol className="pipeline-steps">
            <li className="pipeline-step">
              <span className="pipeline-step-num">1</span>
              <div>
                <strong>Formalize the claim</strong>
                <code>
                  accountId={witness.accountId} · balance=${witness.balance.toLocaleString()} (private) · blocked={witness.blocked} (private) ·
                  salt=… (private)
                </code>
                <p>The plain-English claim becomes four typed field-element inputs. Balance, blocked, and salt never leave this step.</p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-step-num">2</span>
              <div>
                <strong>Commit — leaf = Poseidon(accountId, balance, salt, blocked)</strong>
                <code>{truncate(witness.leafHash, 14, 10)}</code>
                <p>One field element now binds all four values together. Change the balance by $1 and this number changes completely.</p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-step-num">3</span>
              <div>
                <strong>Attest — EdDSA-Poseidon.sign(custodianKey, leaf)</strong>
                <code>
                  R8x={truncate(witness.attestation.R8x)} · S={truncate(witness.attestation.S)}
                </code>
                <p>The custodian's real private key signs the leaf. A claim with no matching signature can never produce a witness.</p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-step-num">4</span>
              <div>
                <strong>Anchor — Merkle path (depth {witness.pathElements.length}) to the committed root</strong>
                <code>{witness.pathElements.length} sibling hashes → root {truncate(witness.merkleRoot)}</code>
                <p>Proves this exact leaf really sits inside the custodian's published tree — not a leaf invented for this one proof.</p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-step-num">5</span>
              <div>
                <strong>Threshold check — balance &gt; threshold, evaluated inside the circuit</strong>
                <code>
                  ${account.balance.toLocaleString()} &gt; ${DEMO_THRESHOLD.toLocaleString()} → {clearsThreshold ? 'TRUE' : 'FALSE'}
                </code>
                <p>{clearsThreshold ? 'Clears the bar.' : 'Does not clear the bar — on its own, this alone blocks a proof.'}</p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-step-num">6</span>
              <div>
                <strong>Block status check — blocked === 0, evaluated inside the circuit</strong>
                <code>
                  blocked={witness.blocked} → {isBlocked ? 'FALSE (custodian-flagged)' : 'TRUE (clear)'}
                </code>
                <p>{isBlocked ? 'The custodian has flagged this account. No proof can be constructed, even though it clears the balance bar above.' : 'The custodian has not flagged this account.'}</p>
              </div>
            </li>
            <li className={`pipeline-step pipeline-verdict ${wouldProve ? 'ok' : 'fail'}`}>
              <span className="pipeline-step-num">=</span>
              <div>
                <strong>Would a real proof succeed for this exact account and threshold?</strong>
                <code>{wouldProve ? 'YES — try it in the Live Verification console above.' : 'NO — try it in the Live Verification console above and watch it get rejected.'}</code>
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
                      <li>balance (${account.balance.toLocaleString()})</li>
                      <li>blocked ({witness.blocked})</li>
                      <li>salt</li>
                      <li>custodian signature</li>
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
                      <li>threshold</li>
                      <li>trade ID</li>
                      <li>custodian public key</li>
                      <li>the Groth16 proof itself</li>
                    </ul>
                  </div>
                </div>
              </div>
            </li>
          </ol>
        </>
      )}
    </div>
  )
}

function AuditLogPanel({ refreshSignal }: { refreshSignal: number }) {
  const [log, setLog] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    getAuditLog()
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
          <h3>Every real request, persisted to disk.</h3>
        </div>
        <button className="refresh-button" onClick={load} aria-label="Refresh audit log">
          <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      <p>
        Pulled from <code>GET /api/audit-log</code> — an append-only file on the server (<code>build/audit-log.jsonl</code>) that survives
        restarts. Every proof attempt on this page appears here the instant it happens.
      </p>
      <div className="audit-table">
        <div className="audit-row audit-head">
          <span>TIME</span>
          <span>ENDPOINT</span>
          <span>ACCOUNT</span>
          <span>RESULT</span>
          <span>REASON</span>
        </div>
        {log.length === 0 && <div className="audit-empty">No requests logged yet — run a proof above.</div>}
        {log.map((e, i) => (
          <div className={`audit-row ${e.result}`} key={`${e.timestamp}-${i}`}>
            <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
            <span>
              {e.endpoint}
              {e.mode ? ` / ${e.mode}` : ''}
            </span>
            <span>{e.accountId}</span>
            <span>{e.result}</span>
            <span>{e.reason ?? '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function CryptoConsole({ book, auditTick }: { book: TreasuryBook | null; auditTick: number }) {
  const [localTick, setLocalTick] = useState(0)
  const institutions = book?.institutions ?? []

  if (!institutions.length) return null

  return (
    <section className="crypto-console scene" id="console">
      <div className="section-intro">
        <p className="eyebrow">PROOF OF WORK / 05</p>
        <h2>
          Don't take our
          <br />
          <em>word for it.</em>
        </h2>
        <p className="console-lede">
          Everything below calls the real ZK-Attest backend, live. No canned responses, no fixed accounts, no fallback data if it's unreachable —
          pick your own numbers and watch the actual cryptography run.
        </p>
      </div>
      <div className="console-grid">
        <LiveConsole institutions={institutions} onActivity={() => setLocalTick((t) => t + 1)} />
        <Pipeline institutions={institutions} />
      </div>
      <AuditLogPanel refreshSignal={auditTick + localTick} />
    </section>
  )
}
