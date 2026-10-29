# W08 → W09 handover

Status: **W08 ENGINEERING ACCEPTED** (`W08_ENGINEERING_PASS`) at engineering source HEAD `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`; all four W08 streams (W08-1…W08-4) closed on that SHA; final engineering Compose PASS run 40914723992 on the same SHA. Base: post-W07 `main` `0dae2c6c5f2399bf3303b4be1d6853ad6f84fc34`. All freeze flags unchanged; **production readiness false**. Nothing below reopens W08 engineering work; W09/RC1 is next.

## 1. Remaining W08 engineering work

| ID | Item | Where | Note |
|---|---|---|---|
| W08-1 | Genuine V4 browser graduation | `apps/forge-web/test/e2e`, `test/e2e/global-setup.ts`, `.github/workflows/w03.yml` | **CLOSED** — the genuine-V4 production-build browser job PASSED on the engineering HEAD `0f171ac4` in exact-head CI (minted liquidity/position asserted by the job; full J01–J19 execution) |
| W08-2 | Independent financial reconciliation + recovery acceptance | `apps/forge-web/test/unit/w08-financial-oracle.test.ts` | **CLOSED** — the independent oracle passes in exact-head CI on `0f171ac4`; the compose reorg/claim fault drill is EXECUTED and PASSING (evidence JSON from run 40911719094 @ `893da5d`, re-executed green within compose run 40914723992 @ `0f171ac4`; docs/W08-STAGING-RECOVERY.md financial recovery drill row). Independent external financial review remains open (C01–C03) |
| W08-3 | Beta browser E2E re-run on the W08 stack | `pnpm test:e2e` and isolated genuine J01–J19 job | **CLOSED** — both the standard production-build 18-case suite and the genuine-V4 journey (J14–J17 included) PASS on the engineering HEAD `0f171ac4` |
| W08-4 | Compose smoke evidence attachment | manual workflow `.github/workflows/w06-compose-smoke.yml` | **CLOSED** — run 40914723992 @ `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`, `conclusion: success`, every step green; recorded evidence includes the signing fail-closed audit `denied:allowed:signed = 1:0:0`, backup/restore digest agreement (`4b1e1c92…`), migration-drift refusal and the Correction D financial recovery drill |

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
