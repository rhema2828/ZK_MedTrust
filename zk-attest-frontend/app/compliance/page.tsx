'use client'

import { ArrowUpRight } from 'lucide-react'
import ComplianceDashboard from '@/components/compliance-dashboard'

export default function CompliancePage() {
  return (
    <main id="top">
      <header className="site-header">
        <a className="brand" href="/" aria-label="ZK-Attest home">
          <span className="brand-mark">
            <span />
            <span />
          </span>
          <span>
            <strong>ZK—ATTEST</strong>
            <small>COMPLIANCE VERIFICATION</small>
          </span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/">Settlement demo</a>
          <a href="#matrix">Criteria matrix</a>
          <a href="#console">Proof console</a>
        </nav>
        <a className="text-link" href="/">
          ← Back <ArrowUpRight size={15} style={{ transform: 'rotate(-135deg)' }} />
        </a>
      </header>
      <ComplianceDashboard />
      <footer>
        <span>ZK—ATTEST / COMPLIANCE</span>
        <span>15 CASES · 20 CRITERIA</span>
        <span>DEMO ENVIRONMENT · 2026</span>
      </footer>
    </main>
  )
}
