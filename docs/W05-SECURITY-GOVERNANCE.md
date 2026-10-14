# W05 — Security review, owner-authority and governance

Flags unchanged: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`. Nothing here is an external audit or approval.

## 1. Authority matrix
Every state-changing function of the ten Forge-owned contracts is classified (access class, timelock, blast radius, emergency role, monitoring events) in `apps/forge-web/config/authority-matrix.json`, rendered to `docs/W05-AUTHORITY-MATRIX.md`. Gates: `w05-authority-matrix.test.ts` fails on any unclassified or stale function, an unknown access class, a monitoring event that does not exist in the ABI, a changed emergency set, or hand-edited markdown.

## 2. Findings register (`release/security-findings.json`)
| Id | Sev | Status | Summary |
|---|---|---|---|
| F-03 | high | disclosed-owner-trust | Factory owner can redirect a launch's creator-fee recipient (3 d notice + 3 d window); reaches accrued-unswept fees and unreleased vest |
| F-04 | high | disclosed-owner-trust | Owner rescue hatches (`rescueCurveFees`, `rescuePoolFees`, `rescueSweptGraduation`, `forceSweptGraduation`) |
| F-05 | medium | disclosed-owner-trust | Fee-sweep operator picks conversion/buyback price floors |
| W05-01 | high | **fixed** | A compromised revenue attestor could exhaust the nonce space and sign an unbounded ceiling. Fix: strictly sequential nonce (`StaleNonce` otherwise) and `ceiling <= escrowClaimed + escrow held` (`CeilingExceedsEscrow`) |
| W05-02 | medium | disclosed-owner-trust | `renounceOwnership` open on `ForgeBindingRegistry` / `ForgeLaunchAuthorizer`; renouncing freezes authority rotation and the launch kill switch |
| W05-03 | medium | disclosed-owner-trust | Under a timelocked owner every owner function, including emergency stops, inherits the delay; immediate containment is off-chain |
| W05-04 | low | disclosed-owner-trust | `rescuePoolFees` never rescues a native-quote bucket (by design) |
| F-07 / F-09 | medium | open | No external audit of current code (C01); BUSL-1.1 legal review (C04) |

"disclosed-owner-trust" means documented, monitored and routed to Class C review (C03). **No external reviewer has accepted any of it.** No financial authority was removed or silently altered (F-03/F-04 stay as deployed-source behaviour); the only contract change in W05 is W05-01 in the Forge-owned splitter.

## 3. F-03 / F-04 — measured by `test-forge/W05OwnerPowers.t.sol` (11 tests)
The tests execute each power against genuine contracts and record its true reach (what it can and cannot move): the owner can redirect future and accrued-unswept creator fees and unreleased vest after the notice window, but cannot touch already-claimed funds or pooled liabilities of other launches; rescues only reach buckets they name. Mitigations proposed (none activated, none requiring a contract change):
1. Owner = Safe + self-administered timelock (≥ 2 d); the recipient-change and rescue events raise `SUSPICIOUS_RECIPIENT_CHANGE` / `OWNER_RESCUE` alerts and are surfaced in the public governance page.
2. Publish the powers in launch disclosures (UI already shows them) and in the authority matrix.
3. For a *future* factory version (separate reviewed workflow, not W05): narrow F-03 to forward-only changes with creator opt-out, bound rescues to stuck-state predicates, disable `renounceOwnership` on the registry/authorizer. Needs governance + independent review; deliberately not invented here.

## 4. Attestor compromise — `test-forge/W05AttestorCompromise.t.sol` (7 tests)
A trusted attestor is **not** trustless provenance (disclosure preserved). Bounds: sequential nonce, ceiling ≤ escrow claimed + held, deadline, evidence blockhash. `revokeRevenueAttestor()` stops NEW authorizations only; existing headroom stays pullable, so the incident procedure is revoke **and** `setPullsPaused(true)` (runbook §D3, drilled in `w05-incident-drills.test.ts`). Open risk: `blockhash(evidenceBlock)` vs RPC block hash on Arbitrum-Orbit chains — probed by CI-only `test/v4-fork/arbos-block-semantics.test.ts`; if it fails on 4663 the evidence-block check needs a reviewed redesign (production blocker, not hidden).

## 5. Governance arrangement (simulated with genuine Safe 1.5.0 + OZ TimelockController)
`scripts/w05/governance.ts` + `w05-governance.test.ts`. Policy floor enforced by `checkGovernancePolicy`: ≥ 3 owners, threshold ≥ 2 and strict majority, timelock ≥ 2 days, timelock admin = 0 (self-administered), no forbidden owners (deployer/relayer/signer/attestor keys). Ownership transfers use `Ownable2Step`; the simulation proves schedule → wait → execute and that Safe-only proposers are enforced. No universal timelock is claimed: each function's actual delay is in the matrix. No ownership was transferred anywhere.

## 6. Immediate vs confirmed controls
Immediate (off-chain, `emergency_lockdown`, signer allowlist/pause): stop new attestations and new bindings, refuse draft/authorize/signature. On-chain (`setLaunchEnabled`, `setEligibilityAuthority(0)`, `setPullsPaused`, `revokeRevenueAttestor`, `invalidatePendingOps`) take effect only when the owner transaction confirms — and, under a timelocked owner, only after the delay (W05-03). See `W05-INCIDENT-RUNBOOK.md`.
