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
| W05-05 | high | **fixed** (real-chain confirmation = CI probe) | CI against the real 4663 RPC measured EVM `block.number` = parent-chain number (26,193,299) ≠ RPC L2 block (88,673,151); the evidence check reverted `StaleEvidence` for every attestation. Fix: head/hash via ArbSys `arbBlockNumber`/`arbBlockHash` (0x64) when it answers, native opcodes otherwise; tests with an etched ArbSys double (`test_H2_*`) |
| W05-06 | high | **fixed** (PR #5 Correction A) | `revokeRevenueAttestor()` left `pendingRevenueAttestor` in place: propose B → timelock matures → revoke A → anyone executes → B active, undoing the emergency revocation (reproduced on the unfixed contract). Fix: revocation discards the pending rotation and pauses pulls atomically; `EmergencyRevocation` event; tests `W05EmergencyRevocation.t.sol` (A–J) |
| W05-07 | medium | **fixed** (PR #5 Correction A) | `SignerRegistry` verified roles once and then trusted that state (a revoked/rotated on-chain authority could keep signing; a sticky disable could never recover). Fix: fresh on-chain snapshot per signing request, fail closed on RPC error, custody conflict sticky (`w05-signer-freshness.test.ts`) |
| W05-02 | medium | disclosed-owner-trust | `renounceOwnership` open on `ForgeBindingRegistry` / `ForgeLaunchAuthorizer`; renouncing freezes authority rotation and the launch kill switch |
| W05-03 | medium | disclosed-owner-trust | Under a timelocked owner every owner function, including emergency stops, inherits the delay; immediate containment is off-chain |
| W05-04 | low | disclosed-owner-trust | `rescuePoolFees` never rescues a native-quote bucket (by design) |
| F-07 / F-09 | medium | open | No external audit of current code (C01); BUSL-1.1 legal review (C04) |

"disclosed-owner-trust" means documented, monitored and routed to Class C review (C03). **No external reviewer has accepted any of it.** No financial authority was removed or silently altered (F-03/F-04 stay as deployed-source behaviour); the only contract changes in W05 are W05-01, W05-05 and W05-06 (all in the Forge-owned splitter).

## 3. F-03 / F-04 — measured by `test-forge/W05OwnerPowers.t.sol` (11 tests)
The tests execute each power against genuine contracts and record its true reach (what it can and cannot move): the owner can redirect future and accrued-unswept creator fees and unreleased vest after the notice window, but cannot touch already-claimed funds or pooled liabilities of other launches; rescues only reach buckets they name. Mitigations proposed (none activated, none requiring a contract change):
1. Owner = Safe + self-administered timelock (≥ 2 d); the recipient-change and rescue events raise `SUSPICIOUS_RECIPIENT_CHANGE` / `OWNER_RESCUE` alerts and are surfaced in the public governance page.
2. Publish the powers in launch disclosures (UI already shows them) and in the authority matrix.
3. For a *future* factory version (separate reviewed workflow, not W05): narrow F-03 to forward-only changes with creator opt-out, bound rescues to stuck-state predicates, disable `renounceOwnership` on the registry/authorizer. Needs governance + independent review; deliberately not invented here.

## 4. Attestor compromise — `test-forge/W05AttestorCompromise.t.sol` (7 tests)
A trusted attestor is **not** trustless provenance (disclosure preserved). Bounds: sequential nonce, ceiling ≤ escrow claimed + held, deadline, evidence blockhash. `revokeRevenueAttestor()` is now atomic: it stops NEW authorizations, discards any pending rotation and pauses pulls (existing ceilings are not erased, claims are never blocked); resuming needs a NEW timelocked proposal and an explicit owner unpause (runbook §D3, drilled in `w05-incident-drills.test.ts`). Evidence-block semantics (W05-05): measured on the real 4663 RPC, EVM `block.number`/`blockhash` do not match RPC L2 numbering, so the check now uses ArbSys (0x64). Local tests use an ArbSys double; the real-chain property (ArbSys head = RPC block, `arbBlockHash(N-1)` = RPC hash) is asserted only by the CI probe `test/v4-fork/arbos-block-semantics.test.ts`. The attestor must continue to take evidence from the L2 RPC.

## 5. Governance arrangement (simulated with genuine Safe 1.5.0 + OZ TimelockController)
`scripts/w05/governance.ts` + `w05-governance.test.ts`. Policy floor enforced by `checkGovernancePolicy`: ≥ 3 owners, threshold ≥ 2 and strict majority, timelock ≥ 2 days, timelock admin = 0 (self-administered), no forbidden owners (deployer/relayer/signer/attestor keys). Ownership transfers use `Ownable2Step`; the simulation proves schedule → wait → execute and that Safe-only proposers are enforced. No universal timelock is claimed: each function's actual delay is in the matrix. No ownership was transferred anywhere.

## 6. Immediate vs confirmed controls
Immediate (off-chain, `emergency_lockdown`, signer allowlist/pause): stop new attestations and new bindings, refuse draft/authorize/signature. On-chain (`setLaunchEnabled`, `setEligibilityAuthority(0)`, `setPullsPaused`, `revokeRevenueAttestor`, `invalidatePendingOps`) take effect only when the owner transaction confirms — and, under a timelocked owner, only after the delay (W05-03). See `W05-INCIDENT-RUNBOOK.md`.
