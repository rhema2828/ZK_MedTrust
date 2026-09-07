'use client'

import { useEffect, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Copy, LoaderCircle, ShieldCheck, Sparkles, X } from 'lucide-react'
import {
  generateProof,
  runTamper,
  getTreasuryBook,
  type ProveResult,
  type TreasuryBook,
  type Institution,
} from '@/lib/zk-attest-api'
import ZKAttestScene from '@/components/zk-attest-scene'
import CryptoConsole from '@/components/crypto-console'

type Verdict = 'ready' | 'authorized' | 'blocked' | 'rejected' | 'error'

// The five real circuit verification stages, in the order the circuit
// actually checks them (circuits/settlement.circom in the main repo) — not
// a generic/illustrative ZK pipeline.
// Order matches the circuit's actual constraint order exactly (see
// circuits/settlement.circom): threshold is checked BEFORE the block flag,
// so a genuinely-above-threshold blocked account (1005) fails at step 05,
// not step 04 — a subtle but real distinction worth getting right, since
// getting it wrong would misrepresent which check actually rejected it.
const architecture = [
  ['01', 'LEAF COMMITMENT', 'leaf = Poseidon(id, balance, salt, blocked)', 'Bind the account, its balance, and its block status to one Poseidon hash.'],
  ['02', 'CUSTODIAN ATTESTATION', 'EdDSA-Poseidon.verify(leaf, sig, pubKey)', 'Reject any claim the custodian never actually signed, in-circuit.'],
  ['03', 'MERKLE MEMBERSHIP', 'MerklePath(leaf) === root', 'Prove the attested leaf is really in the custodian’s committed tree.'],
  ['04', 'THRESHOLD CHECK', 'balance > threshold', 'Prove the balance clears the bar without revealing the balance itself.'],
  ['05', 'BLOCK STATUS CHECK', 'blocked === 0', 'Reject any account the custodian has flagged, even one that clears every other check.'],
  ['06', 'TRADE BINDING', 'tradeId² (public)', 'Bind the proof to one trade so a finished proof can’t be replayed for another.'],
]

const truncate = (value: string, head = 10, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value)

function Header({ sanctions, onToggle }: { sanctions: boolean; onToggle: () => void }) {
  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="ZK-Attest home">
        <span className="brand-mark"><span /><span /></span>
        <span><strong>ZK—ATTEST</strong><small>PRIVATE CLEARING INFRASTRUCTURE</small></span>
      </a>
      <nav aria-label="Main navigation">
        <a href="#overview">Overview</a>
        <a href="#settlement">Settlement</a>
        <a href="#console">Proof of work</a>
        <a href="#architecture">Architecture</a>
      </nav>
      <button className={`sanctions-control ${sanctions ? 'active' : ''}`} onClick={onToggle} aria-pressed={sanctions}>
        <i /> DEMO ACCOUNT <b>{sanctions ? 'BLOCKED (1005)' : 'CLEAR (1001)'}</b>
      </button>
    </header>
  )
}

function Hero({ onExplore }: { onExplore: () => void }) {
  return (
    <section className="hero scene" id="overview">
      <div className="hero-copy">
        <p className="eyebrow">CRYT_NEW / CLEARING TERMINAL 01</p>
        <h1>Compliance<br /><em>without disclosure.</em></h1>
        <p className="hero-sub">A cryptographic attestation layer for private enterprise state and cross-border settlement.</p>
        <div className="hero-actions">
          <button className="primary-button" onClick={onExplore}>Explore settlement <ArrowDownRight size={16} /></button>
          <a className="text-link" href="#architecture">View architecture <ArrowUpRight size={15} /></a>
        </div>
      </div>
      <div className="hero-art" aria-label="ZK-Attest private clearing dashboard visualization" role="img">
        <div className="hero-orb" />
        <div className="hero-art-copy">
          <span>PRIVATE CLEARING</span>
          <strong>Ascend beyond limits<br />with intelligent<br /><em>proof infrastructure</em></strong>
        </div>
        <div className="hero-dashboard">
          <div className="dashboard-bar"><i /><i /><i /><span>zk-attest / terminal</span><b>●</b></div>
          <div className="dashboard-nav"><span>Settlement</span><span>Proofs</span><span>Networks</span><span>Verification</span></div>
          <div className="dashboard-metrics">
            <div><small>Custodian tree</small><strong>5 accounts</strong><span className="metric-line" /></div>
            <div><small>Circuit constraints</small><strong>6,510</strong><span className="metric-dots" /></div>
            <div><small>Verify time</small><strong>~11ms</strong><span className="metric-bars"><i /><i /><i /><i /><i /></span></div>
          </div>
          <div className="dashboard-footer"><span>Real-time private state</span><b>VERIFIED / CLEAR</b><span>Public certainty →</span></div>
        </div>
        <span className="art-label art-top">PRIVATE STATE / MERKLE-COMMITTED</span>
        <span className="art-label art-bottom">CIRCUIT <b>settlement.circom</b></span>
      </div>
      <span className="scroll-note">SCROLL TO ENTER THE SYSTEM <ArrowDownRight size={14} /></span>
    </section>
  )
}

function Comparison({ book }: { book: TreasuryBook | null }) {
  const rootDisplay = book ? truncate(book.merkleRoot, 10, 6) : '—'
  return (
    <section className="comparison scene">
      <div className="section-intro">
        <p className="eyebrow">THE TRANSMISSION PROBLEM</p>
        <h2>Move the<br /><em>assertion.</em><br />Not the data.</h2>
      </div>
      <div className="comparison-grid">
        <div className="transmission traditional">
          <div className="comparison-head"><span>01 / TRADITIONAL TRANSMISSION</span><CircleAlert size={15} /></div>
          <p className="comparison-title">Information transfer</p>
          <div className="data-stack">
            {[['ACCOUNT ID', '1001'], ['BALANCE', '$12,500,000'], ['CUSTODIAN', 'Meridian Capital Partners'], ['BLOCK STATUS', 'CLEAR']].map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </div>
          <div className="exposure-list"><span>ACCOUNT IDENTITY EXPOSED</span><span>BALANCE SHEET EXPOSED</span><span>CUSTODIAN RECORD EXPOSED</span></div>
        </div>
        <div className="comparison-divider"><span>VS</span></div>
        <div className="transmission attest">
          <div className="comparison-head"><span>02 / ZK—ATTEST</span><ShieldCheck size={15} /></div>
          <p className="comparison-title">Assertion transfer</p>
          <div className="proof-stack">
            <div><span>ROOT</span><strong>{rootDisplay}</strong></div>
            <div><span>THRESHOLD</span><strong>1,000,000</strong></div>
            <div><span>TRADE ID</span><strong>bound per-request</strong></div>
          </div>
          <div className="exposure-list safe"><span>PRIVATE STATE</span><span>PROOF GENERATED</span><span>COMPLIANCE VERIFIED</span></div>
        </div>
      </div>
    </section>
  )
}

function Settlement({
  account,
  onRequest,
  loading,
  verdict,
  result,
  errorMessage,
}: {
  account: Institution | undefined
  onRequest: () => void
  loading: boolean
  verdict: Verdict
  result: ProveResult | null
  errorMessage: string | null
}) {
  const status =
    verdict === 'authorized' ? 'AUTHORIZED' :
    verdict === 'blocked' ? 'PROOF REJECTED — BLOCKED' :
    verdict === 'rejected' ? 'PROOF REJECTED' :
    verdict === 'error' ? 'BACKEND UNAVAILABLE' :
    loading ? 'GENERATING PROOF' : 'READY FOR ATTESTATION'

  const publicSignals = result && result.ok ? result.publicSignals : null
  const payloadFields = account
    ? [
        ['ACCOUNT ID', String(account.accountId)],
        ['CUSTODIAN', account.name],
        ['BALANCE', `$${account.balance.toLocaleString()}`],
        ['BLOCK STATUS', account.blocked ? 'FLAGGED' : 'CLEAR'],
      ]
    : []

  return (
    <section className={`settlement scene ${verdict}`} id="settlement">
      <div className="settlement-heading">
        <div><p className="eyebrow">INSTITUTIONAL SETTLEMENT / 02</p><h2>Cross-border<br /><em>authorization.</em></h2></div>
        <div className="settlement-id"><span>TRANSFER REFERENCE</span><strong>ZK—SETTLEMENT—{account?.accountId ?? '—'}</strong></div>
      </div>
      <div className="settlement-layout">
        <div className="payload-line">
          <span className="line-label">PRIVATE ENTERPRISE STATE</span>
          {payloadFields.map(([label, value]) => <div className="payload-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
          <span className="payload-foot">PAYLOAD REMAINS LOCAL <span>never leaves this request</span></span>
        </div>
        <div className={`settlement-visual ${loading ? 'is-running' : ''} ${verdict === 'authorized' ? 'is-authorized' : ''}`}>
          <ZKAttestScene running={loading} authorized={verdict === 'authorized'} blocked={verdict === 'blocked' || verdict === 'rejected'} />
          <span className="visual-caption">ZK—ATTEST<br /><b>{loading ? 'EXECUTING PROOF' : verdict === 'authorized' ? 'VERIFIED / CLEAR' : verdict === 'error' ? 'BACKEND UNREACHABLE' : (verdict === 'blocked' || verdict === 'rejected') ? 'PROOF REJECTED' : 'AWAITING REQUEST'}</b></span>
        </div>
        <div className="authorization-line">
          <span className="line-label">PUBLIC VERIFICATION</span>
          <div className="proof-values">
            {[
              ['MERKLE ROOT', publicSignals ? truncate(publicSignals[0]) : 'pending'],
              ['THRESHOLD', publicSignals ? publicSignals[1] : 'pending'],
              ['TRADE ID', publicSignals ? publicSignals[2] : 'pending'],
            ].map(([label, value]) => (
              <div key={label}><span>{label}</span><strong>{value}</strong><button aria-label={`Copy ${label}`}><Copy size={13} /></button></div>
            ))}
          </div>
          <div className="authorization-foot"><span>PII TRANSMITTED</span><strong>0 BYTES</strong></div>
        </div>
      </div>
      <div className="settlement-action">
        <button className="execute-button" onClick={onRequest} disabled={loading}>
          {loading ? <><LoaderCircle className="spin" size={16} /> Generating proof</> : <>{verdict === 'authorized' || verdict === 'blocked' || verdict === 'rejected' || verdict === 'error' ? 'Execute again' : 'Execute cross-border transfer'} <ArrowUpRight size={16} /></>}
        </button>
        <span>By proceeding, the real ZK-Attest backend generates and verifies a Groth16 proof against the account currently selected above.</span>
      </div>
      <div className={`verdict-line ${verdict}`}>
        <div><span className="eyebrow">SYSTEM VERDICT</span><strong>{status}</strong></div>
        <p>
          {verdict === 'authorized' ? 'Balance clears the threshold, custodian signature verified, account not blocked. Cryptographic execution complete.' :
           verdict === 'blocked' ? 'Custodian-flagged account. The circuit’s blocked === 0 constraint has no satisfying witness — no proof can be constructed.' :
           verdict === 'rejected' ? (errorMessage ?? 'The proof could not be constructed for this claim.') :
           verdict === 'error' ? (errorMessage ?? 'Could not reach the ZK-Attest backend.') :
           'Submit the transfer to generate a real proof against the live backend.'}
        </p>
        <span className="verdict-time">{result && result.ok ? `${result.proveMs} MS` : '—'}</span>
      </div>
    </section>
  )
}

// Same order as `architecture` above, and for the same reason: threshold
// passes before the block check runs, so the blocked-account demo case must
// show THRESHOLD CHECK as passed and BLOCK STATUS CHECK as the rejection —
// not the other way around.
const TRACE_STAGES = ['LEAF COMMITMENT', 'CUSTODIAN ATTESTATION', 'MERKLE MEMBERSHIP', 'THRESHOLD CHECK', 'BLOCK STATUS CHECK', 'TRADE BINDING']
const BLOCK_STAGE_INDEX = 4

function Trace({ result, open, onToggle, verdict }: { result: ProveResult | null; open: boolean; onToggle: () => void; verdict: Verdict }) {
  const publicSignals = result && result.ok ? result.publicSignals : null
  return (
    <section className="trace scene">
      <button className="trace-toggle" onClick={onToggle} aria-expanded={open}>
        <span><span className="eyebrow">TECHNICAL INSPECTION / 03</span><strong>Verification trace</strong></span>
        <ChevronDown size={18} className={open ? 'rotate' : ''} />
      </button>
      {open && (
        <div className="trace-content">
          {TRACE_STAGES.map((stage, index) => {
            const complete = verdict === 'authorized'
            const reachedBlockedCheck = verdict === 'blocked' && index < BLOCK_STAGE_INDEX // every earlier check passes before the block-flag check fails
            return (
              <div className={`trace-stage ${complete || reachedBlockedCheck ? 'complete' : ''}`} key={stage}>
                <span className="stage-number">0{index + 1}</span>
                <div><strong>{stage}</strong><span>{complete ? 'VERIFIED' : reachedBlockedCheck ? 'PASSED' : verdict === 'blocked' && index === BLOCK_STAGE_INDEX ? 'REJECTED' : verdict === 'blocked' ? 'NOT REACHED' : 'AWAITING EXECUTION'}</span></div>
                <code>{complete || reachedBlockedCheck ? (publicSignals ? truncate(publicSignals[0]) : '—') : '—'}</code>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Architecture() {
  return (
    <section className="architecture scene" id="architecture">
      <div className="section-intro"><p className="eyebrow">THE PROTOCOL / 04</p><h2>From private state<br />to <em>public certainty.</em></h2></div>
      <div className="architecture-list">
        {architecture.map(([number, title, formula, description]) => (
          <div className="architecture-row" key={number}>
            <span className="architecture-number">{number}</span>
            <div className="architecture-title"><h3>{title}</h3><code>{formula}</code></div>
            <p>{description}</p>
            <ArrowUpRight size={17} />
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Page() {
  const [verdict, setVerdict] = useState<Verdict>('ready')
  const [result, setResult] = useState<ProveResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [sanctions, setSanctions] = useState(false) // false = account 1001 (clear), true = account 1005 (custodian-flagged blocked)
  const [loading, setLoading] = useState(false)
  const [traceOpen, setTraceOpen] = useState(false)
  const [book, setBook] = useState<TreasuryBook | null>(null)
  const [auditTick, setAuditTick] = useState(0)

  useEffect(() => {
    getTreasuryBook().then(setBook).catch(() => setBook(null))
  }, [])

  const selectedAccountId = sanctions ? 1005 : 1001
  const account = book?.institutions.find((a) => a.accountId === selectedAccountId)

  const request = async () => {
    if (loading) return
    setLoading(true)
    setVerdict('ready')
    setErrorMessage(null)

    const threshold = 1_000_000
    const tradeId = Date.now()

    const outcome = sanctions
      ? await runTamper({ mode: 'blocked_account', threshold, tradeId })
      : await generateProof({ accountId: selectedAccountId, threshold, tradeId })

    setResult(outcome)
    setLoading(false)
    setAuditTick((t) => t + 1)

    if (outcome.ok) {
      setVerdict('authorized')
      return
    }
    if (outcome.networkError) {
      setVerdict('error')
      setErrorMessage(outcome.error)
      return
    }
    setErrorMessage(outcome.error)
    setVerdict(outcome.failedAt === 'blocked' ? 'blocked' : 'rejected')
  }

  return (
    <main id="top">
      <Header sanctions={sanctions} onToggle={() => setSanctions((s) => !s)} />
      <Hero onExplore={() => document.getElementById('settlement')?.scrollIntoView({ behavior: 'smooth' })} />
      <Comparison book={book} />
      <Settlement account={account} onRequest={request} loading={loading} verdict={verdict} result={result} errorMessage={errorMessage} />
      <Trace result={result} open={traceOpen} onToggle={() => setTraceOpen((open) => !open)} verdict={verdict} />
      <CryptoConsole book={book} auditTick={auditTick} />
      <Architecture />
      <footer><span>ZK—ATTEST / CRYT_NEW</span><span>PRIVATE CLEARING INFRASTRUCTURE</span><span>DEMO ENVIRONMENT · 2026</span></footer>
    </main>
  )
}
