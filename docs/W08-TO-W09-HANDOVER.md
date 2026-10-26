# W08 → W09 handover

Status: W08 engineering development in progress on `feat/forge-w08-beta-acceptance` (Draft PR). Base: post-W07 `main` `0dae2c6c5f2399bf3303b4be1d6853ad6f84fc34`. All freeze flags unchanged; production readiness false. This file lists remaining actionable work only.

## 1. Remaining W08 engineering work

| ID | Item | Where | Note |
|---|---|---|---|
| W08-1 | Genuine V4 browser graduation (inherited E2) | `apps/forge-web/test/e2e` + sandbox deploy | The e2e stack still graduates on the sandbox pool; switch the staging deployment's graduation to the genuine V4 pool manager already covered by `test/v4`, without new contract powers |
| W08-2 | Independent financial reconciliation additions | `apps/forge-web/test` | Extend the ledger/reconciliation suites with cross-checks implemented independently of production calculations (oracle-style) across multi-launch, multi-creator histories |
| W08-3 | Beta browser E2E re-run on the W08 stack | `pnpm test:e2e` | Repeat the 18-test journey after the staging drills stabilize; report pass/fail distribution |
| W08-4 | Compose smoke evidence attachment | manual workflow | Run on the final W08 HEAD; record run id + SHA in docs/W08-BETA-ACCEPTANCE.md §2 |

## 2. External / operator dependencies (unchanged classes)

B01 GitHub App; B02 KMS/HSM custody; B03 production Safe+timelock; B04 production RPC; B05 deployment/treasury approval; B06 alert routing; B07 production backup/restore; B08 real CREATE2 hook salt; B09 Robinhood production-write acceptance. C01/C02 independent audit + closure; C03 F-03/F-04 owner powers (`EXTERNAL_FINANCIAL_GOVERNANCE_REVIEW_REQUIRED`); C04 BUSL/legal; C05 launch terms; C06 FINCO tokenomics. Security baseline: 302 entries, `PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW` — independent review still required.

## 3. Concrete W09 work (after W08 closes)

1. **Feature freeze**: last W08 commit pinned; no new engineering changes.
2. **Reproducible clean RC build**: fresh clone at the pinned SHA; `forge build` per profile + `pnpm build`; record toolchain versions and lockfile digests.
3. **Full regression execution**: every CI suite green at the pinned SHA (Forge profiles, app unit/integration/staging, browser E2E, v4, fork probes, scanners, release gate).
4. **Audit snapshot**: source manifest `--check` at the pinned SHA; scanner reports re-generated and diffed against `security/baseline.json` (still unreviewed).
5. **Source provenance lock**: record `git rev-parse HEAD` + tree, submodule pins, image digests from the compose build.
6. **Release artifact checksums**: sha256 of every build artifact + manifest.
7. **RC1 engineering candidate validation**: the release gate reports at most ENGINEERING_PASS; `PRODUCTION_READY=false` hard-coded; Class B/C remain open.
