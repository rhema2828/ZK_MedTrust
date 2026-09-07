# ZK-Attest — frontend

Next.js UI for the ZK-Attest backend in `../zk-attest/` (see that directory's
`API_CONTRACT.md` for the full API this talks to). Originally delivered as a
standalone mockup calling a nonexistent `/generate-proof` / `/toggle-sanction`
API with a fictional KYC/wallet data model and a hardcoded fake proof
fallback — `lib/zk-attest-api.ts` and `app/page.tsx` have been rewritten to
call the real backend, with the real institutional-settlement data model
(accountId/threshold/tradeId, not KYC/wallet), and no fake-data fallback: a
failed request is shown as a failure, not papered over. `components/`
(including the 3D scene) was untouched — it's purely visual and was already
generic enough to describe the real system accurately.

## Running

```
# In ../zk-attest/, first (one-time):
npm install
bash scripts/setup.sh
node server/index.js   # listens on :3000

# In this directory, in a second terminal:
npm install
npm run dev             # listens on :3001 by default if 3000 is taken; set PORT to control it
```

By default this talks to `http://localhost:3000`. Override with
`NEXT_PUBLIC_ZK_ATTEST_API_URL` if the backend runs elsewhere.

The header's account toggle switches between the two demo accounts baked
into the backend's book: **1001** (Meridian Capital Partners, clear) and
**1005** (Halcyon Trade Corp, custodian-flagged blocked — its balance alone
would clear the threshold, but the block flag rejects it regardless). Every
number shown — the Merkle root, threshold, trade ID, proof timing,
constraint count — comes from a real call to the backend above, made at the
moment you click "Execute."

## What was verified, not just written

End-to-end tested with Playwright against a real running backend on this
machine: real account data loads from `/api/book/treasury`, a real proof
generates and authorizes for account 1001, toggling to account 1005 and
re-running correctly produces a real `422` rejection with
`failedAt: "blocked"`, and the verification trace correctly shows threshold
passing before the block check fails (matching the circuit's actual
constraint order — see `../zk-attest/circuits/settlement.circom`). No
console errors beyond the expected/intentional `422` from the tamper
demo itself.
