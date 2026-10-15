# W05 — Release-readiness gate

`pnpm release:gate` evaluates `release/readiness-manifest.json` (stamped from `release/readiness-items.json` with `pnpm release:manifest`; integrity hash checked, tamper ⇒ fail).

| Class | Meaning | Source of truth |
|---|---|---|
| A | Engineering, verified by named CI check-runs on the exact head SHA (`scripts/w05/collect-ci.ts`) | CI |
| B | Operator configuration (GitHub App, KMS custody, Safe/timelock, RPC, treasury, monitoring, backups, hook salt) | Evidence signed by an allowlisted operator key |
| C | Independent audit, legal, financial approvals | Evidence signed by an allowlisted external approver |

`release/approver-registry.json` is **empty** in this repository, so no Class B/C item can pass here and nothing can self-approve. Output states: `ENGINEERING_PASS`, `OPERATOR_CONFIGURATION_REQUIRED`, `EXTERNAL_AUDIT_REQUIRED`, `LEGAL_APPROVAL_REQUIRED`, always with `PRODUCTION_BLOCKED`. Even with every item validly signed the gate reports `productionReady=false` (`PRODUCTION_READY=false as const`); production release needs a separately approved workflow. Blockers also include flag drift (`FINCO_BURN_ENABLED`, `PRODUCTION_BLOCKED`, signing/deploy flags), open critical/high findings, failed reconciliation, unsupported V4 wiring, hook address not source-proven, missing signer-role separation. Negative tests A–J: `test/unit/w05-release-gate.test.ts`.

## Deferred (NOT VERIFIED) Class A scope — PR #5 Correction A

A Class A item may carry `deferred` (reason, steps, coveredBy). It can **never** pass: it reports `NOT_VERIFIED`, adds the state `EVIDENCE_INCOMPLETE`, appears in `evidenceScope.notVerified`, and is not satisfiable by any CI result or signed evidence. A `ciJobs` mapping on a deferred item fails the gate (`DEFERRED_ITEM_HAS_CI_MAPPING`), so a green unrelated job cannot masquerade as the missing evidence. It closes only by a reviewed manifest change that replaces it with a real, mapped job. Current deferred item: `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` (fork steps 7–9); see `W05-ROBINHOOD-V4-DEPLOYMENT.md` for the six-way Robinhood classification. `ENGINEERING_PASS` therefore means "everything that was executed passed", not "everything was tested".

## W06 additions (Class A only)
W06 adds four Class A items and changes nothing about Class B/C or the verdict semantics (`approver-registry.json` is still empty; `PRODUCTION_READY=false`): `A13_STAGING_ACCEPTANCE`, `A14_FULL_JOURNEY_BROWSER` (the existing browser-E2E job now also runs `w06-journey.spec.ts`), `A15_FINANCIAL_GOVERNANCE_ACCEPTANCE`, `A16_AUDIT_DOSSIER_INTEGRITY` (dossier source-manifest drift gate; **not** an audit). `A07e_ROBINHOOD_FORK_REVENUE_CLAIMS_LIFECYCLE` remains `NOT_VERIFIED` (`docs/W06-ROBINHOOD-A07E-ASSESSMENT.md`). See `docs/W06-CONTROLLED-BETA-READINESS.md`.
