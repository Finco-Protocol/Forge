# W05 — Incident runbook (§D1–§D15)

Alert rules (`src/server/ops/monitor.ts`, 20 rules; `/api/ops/alerts`, `/api/ops/metrics` with bearer `FORGE_OPS_TOKEN` ≥ 32 chars) cite these sections. Controls: `pnpm ops:control` (emergency lockdown, env `FORGE_EMERGENCY_LOCKDOWN` or DB `ops_controls`). **Immediate** = off-chain, effective now. **Confirmed** = needs an owner transaction; under a timelocked owner it waits the delay. Drills marked ✔ run in `test/integration/w05-incident-drills.test.ts`; others are covered by the cited existing test.

Escalation: critical → page on-call now, security lead + Safe signers ≤ 15 min; high → page, security lead ≤ 1 h; medium → ticket ≤ 1 business day; low → dashboard. Contact routing is Class B (B06) and not configured in this repository.

| § | Incident | Immediate containment | Confirmed on-chain follow-up | Evidence |
|---|---|---|---|---|
| D1 | GitHub App credentials / webhook secret compromised | Engage lockdown; rotate private key + webhook secret; reject unsigned webhooks (audited) | — | ✔ drill |
| D2 | Eligibility signer compromised | Lockdown + disable signer in allowlist | `setEligibilityAuthority(0)` on authorizer & registry (kill switch), then rotate | ✔ drill |
| D3 | Revenue attestor compromised | Lockdown (stops attestations) | **One** `revokeRevenueAttestor()` transaction (atomic, see below); replacement = NEW proposal + 3 d timelock; resume = explicit `setPullsPaused(false)` | ✔ drill |
| D4 | Relayer key lost | Replace relayer key; it holds no on-chain authority | — | ✔ drill |
| D5 | Treasury recipient key lost | — | Timelocked recipient rotation; allocated liabilities stay claimable by the new recipient | ✔ drill |
| D6 | Unexpected owner action / recipient substitution / fee change | Alert; freeze deployments | Governance response per Safe policy | ✔ drill |
| D7 | Repository transferred / deleted | Webhook triggers revocation job | `invalidatePendingOps` / binding revoke | revocation.test.ts #1 |
| D8 | Revocation stuck / chain reorg | Retry worker; indexer reorg rollback | Re-submit revocation | revocation.test.ts #8 |
| D9 | Indexer crash / stall | Restart; replay from checkpoint | — | ✔ drill; economics.test.ts #24 |
| D10 | Escrow / treasury reconciliation mismatch or deficit | Lockdown; halt claims UI banner | Pause pulls; governance review | ✔ drill |
| D11 | RPC outage | Authorization fails closed (no signature issued); switch to fallback RPC | — | ✔ drill |
| D12 | Launch tx failures | Inspect revert decode; no retry loops | — | integration tests |
| D13 | Wrong quote-asset configuration | Splitter refuses unlisted asset | `setAssetApproved(false)` | ✔ drill |
| D14 | Owner rescue executed | Alert; mark rescued protocol leg non-revenue | — | ✔ drill |
| D15 | Launch attempt during emergency lockdown | Refused immediately; revocations still run; release restores | — | ✔ drill |

Post-incident: preserve structured logs (correlation id per request), export `/api/ops/alerts`, record ledger digest before/after, and open a findings-register entry if a new weakness is found.

## Atomicity guarantees of `revokeRevenueAttestor()` (PR #5 Correction A)

Confirmed ON-CHAIN state is the only containment; an off-chain lockdown is immediate but is not a substitute for it. One owner transaction does all of the following, or none:

1. clears the active attestor (`AttestorNotSet` for every later authorization, so old signatures, signed before or after, are dead);
2. **discards any pending attestor rotation** (`RevenueAttestorChangeCancelled`). A proposal queued — even one whose timelock already matured — before the incident can never be executed afterwards, not even by the permissionless `executeRevenueAttestorChange()` (it reverts `NoPendingChange`). The reproduced bypass was: propose B → timelock matures → revoke A → an unrelated wallet executes → B active;
3. pauses pulls (`PullsPausedUpdated(true)`), so headroom the revoked attestor already authorized cannot be drained. The ceilings are not erased;
4. emits `EmergencyRevocation(revokedAttestor, discardedPending)`.

Never blocked: `claimTreasury` and the escrow's creator claims. Idempotent: repeating the call changes nothing and emits no spurious pause/cancel events.

Recovery is explicit and takes two governance actions: a NEW `proposeRevenueAttestor(next)` + the full 3-day timelock (then anyone may execute it), and an owner `setPullsPaused(false)` — executing a replacement does **not** unpause. If the owner is a timelocked Safe, both the revocation and the unpause inherit that delay (W05-03); the off-chain lockdown and signer kill switch bridge that gap but are not on-chain state.

## Signer authority freshness (PR #5 Correction A)

Every signing request re-reads the on-chain eligibility authority / revenue attestor / owners / treasury recipient (one snapshot per request, no cache). A rotated or revoked on-chain authority refuses the old signer on its next request; an RPC failure refuses signing; a server key found equal to a governance or treasury address trips a sticky custody violation (restart + successful startup verification required). See `W05-SIGNER-CUSTODY.md`.
