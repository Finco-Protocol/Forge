# W09 — RC1 Engineering Candidate & Release Evidence

Status: **RC1 engineering candidate**. Verdict at the end of this file; the live CI/compose evidence for THIS PR's head SHA is listed in the PR description (kept out of commits so the exact-head evidence and the dossier commit can never drift apart). `PRODUCTION_READY=false` — RC1 engineering acceptance never implies production readiness, an audit, or operator approval.

## 1. Baseline pin and merge lineage

| Item | Value |
|---|---|
| RC1 baseline (verified green `main`) | `e09d0dc55124f180020eea38ae43f0b5f4a19889`, tree `8cb75ff10773ec624c329b812dc884acdf9db580` |
| Post-merge main CI at that SHA | all seven standard workflows `success` (CI, W02 Protocol Core, W03 Verified Builder Platform, W05 Production Hardening, W06 Controlled Beta Readiness, Security Toolchain, SonarQube Cloud) |
| W08 provenance | PR #8 merged as `4cdd4bc5c7b81665a3d51a43051e2ad2765880ed` (parents `0dae2c6c…` post-W07 main + `0a76f8b6…` docs-only); W08 engineering HEAD `0f171ac4fb5264a6b45eb26a2dd638b71a7b89ab`; final W08 Compose acceptance run `40914723992` @ `0f171ac4` |
| PR #9 provenance (dependency fix) | merged as `e09d0dc5…` (parents `4cdd4bc5…` + `7d74ee50…`); `7d74ee50` CI: 63 successful / 2 conditional skips / 0 failures incl. the previously failing W03 dependency-audit and W05 release-gate checks |
| Feature freeze | W09 adds NO application, contract, financial or deployment-feature changes: this PR's diff is documentation/evidence only (see §7). RC1 is a stabilization point; any post-freeze change re-runs the full matrix. |
| Active open PRs at baseline | 0 (none could silently enter RC1 scope) |

## 2. Reproducible clean builds (two independent fresh checkouts)

Method: `scripts/w09/rc1-dual-build.sh` executed against two independent fresh clones of the SAME commit (submodules initialised; frozen lockfile; pinned toolchain). Raw evidence: `docs/evidence/w09/rc1-build1.json` + `rc1-build1.hashes` (565 files), `rc1-build2.json` + `rc1-build2.hashes`, machine-readable comparison in `rc1-reproducibility.json`.

| Item | Result |
|---|---|
| Toolchain (both builds identical) | node `v24.21.0`, pnpm `10.28.0` (packageManager pin), Foundry `1.8.5` (`51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f`), solc per profile from `foundry.toml` + build metadata, Windows (MINGW64_NT-10.0-26200) |
| Foundry profiles built | `deployed`, `forge`, `v1`, `testable` (all four green in both builds) |
| Web production build | `pnpm build` green in both builds; ABI/generated-interface parity verified via `pnpm exec tsx scripts/gen-abis.ts --check` in both builds |
| **Foundry contract artifacts** | **BYTE-FOR-BYTE REPRODUCIBLE** — every solc output artifact is hash-identical across the two builds |
| Foundry `build-info` metadata | one file per profile differs ONLY in Foundry's own build `id` (keccak over the compilation timestamp — inherent to Foundry, not this repository); all other fields identical |
| Web (`next build`) artifacts | **FUNCTIONALLY EQUIVALENT, not byte-identical**: all differences trace to Next.js's nondeterministic `BUILD_ID` (names the static-manifest dirs and client page chunks, renumbers server chunks, feeds manifests/types), the profiling `.next/trace`, and generated route `types/` — no source-level nondeterminism |
| Totals | 565 hashed artifacts per build: 501 byte-identical; 49 differing + 15+15 single-build files, ALL in the two classified groups above |
| Lockfile / submodule digests | `pnpm-lock.yaml` sha256 `478e467d44277f3ebbb3bfa064780368f154e1ca6ca7451f8c99da606e243864`; submodule `contractsV2/lib/forge-std` pinned `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` |
| Docker images | the compose stack image (`forge-staging:local`) is built inside the manual Compose acceptance on this PR's head; its digest is recorded with that run in the PR description (no local Docker daemon is available where this was written) |

## 3. Exact-head regression (Class A matrix)

The complete Class A engineering matrix is validated by GitHub CI on THIS PR's exact head SHA and reconciled by the W05 release-readiness gate (`w05: release-readiness gate (ENGINEERING_PASS only; never production-ready)`), which collects the actual check-run outcomes for the head SHA via `scripts/w05/collect-ci.ts` and fails closed on any missing/failed mandatory job. Covered per `release/readiness-items.json` A01–A16: source integrity + vendor gates, reproducible Forge builds, W01/M-ELIG adversarial authorization, ABI/EIP-170/EIP-712, security lint, genuine Uniswap V4 (local + browser graduation), Robinhood 4663 read-only RPC identity + fork simulation (A07a/A07b/A07c; **A07e remains NOT_VERIFIED**), PostgreSQL production mode, platform integration, production-build browser E2E (standard + genuine V4), dependency audit + secret scan, deploy dry-run, staging acceptance, full-journey browser, financial/governance acceptance, audit dossier integrity. The manual Compose acceptance for the RC1 candidate (financial recovery drill, backup/restore digests, RPC-outage fail-closed signing, migration drift refusal, crash/restart recovery) runs on this PR's head SHA — run ID in the PR description.

## 4. Security snapshot

- `release/security-findings.json` (15 entries) is unchanged by W09: F-01/F-02 fixed; F-03/F-04/F-05 remain `disclosed-owner-trust` (C03 governance review); F-07 (no external audit — C01) and F-09 (BUSL-1.1 — C04) remain `open`; W05/W06-era items unchanged. No new findings are introduced by W09 (the dependency fix is PR #9, already merged and audited by CI on its own SHA).
- The Security Toolchain workflow (Slither + Aderyn, actionlint + zizmor, gitleaks, semgrep) and SonarQube run on this PR's exact head; results are CI check-runs, not locally edited claims.
- Baseline status is and remains `PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW` — no scanner result is translated into external audit approval, and the baseline was not edited in W09.

## 5. Financial and production release freeze

Confirmed unchanged at the candidate: approved 70/20/10 allocation methodology, eligible-revenue limitations, third-party-credit exclusions, attestation ceiling constraints, creator claims/conservation, reorg and duplicate-event recovery, signer custody and authority guards (all enforced by the W04–W08 suites in the exact-head matrix). Freeze flags verified in `ops/staging/docker-compose.staging.yml` and `release/readiness-items.json.expectedFlags`: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`. A07e Robinhood fork revenue/claims steps 7–9 remain `NOT_VERIFIED`. B01–B09 and C01–C06 remain open (approver registry intentionally empty; no operator/external evidence exists or is claimed).

## 6. Machine-checkable integrity

- Per-artifact SHA256 manifests: `docs/evidence/w09/rc1-build1.hashes`, `rc1-build2.hashes` (565 entries each, format `<sha256>  <path>`).
- Comparison JSON: `docs/evidence/w09/rc1-reproducibility.json`.
- Reproduction script: `scripts/w09/rc1-dual-build.sh` (Node/pnpm/Foundry built-ins only; re-runnable on any fresh checkout of the candidate commit).
- Release gate: `scripts/w05/collect-ci.ts` + `scripts/w05/release-gate.ts evaluate` re-runnable against the candidate SHA; gate verdict reported in the PR description after the exact-head CI completes.

## 7. W09 diff scope

This PR's only changes are W09 release-evidence documentation and scripts (`docs/evidence/w09/*`, `scripts/w09/rc1-dual-build.sh`): no application code, no Solidity, no financial logic, no workflows/CI configuration, no security gates, no freeze flags, no dependency/lockfile changes. The two code-affecting changes on the RC1 lineage are the W08 merge (PR #8) and the dependency fix (PR #9), both independently CI-verified on their own exact SHAs.

## 8. Verdict

`W09_RC1_ENGINEERING_PASS — READY_FOR_OWNER_REVIEW` **only if** every mandatory check on this PR's final head is green and the manual Compose acceptance passes on the same SHA; the exact numbers live in the PR description. Otherwise `W09_RC1_CORRECTION_REQUIRED` / `W09_BLOCKED_BY_REQUIRED_CHECK`. **`PRODUCTION_READY=false` in every case. STOP WITHOUT MERGING — the Financial Owner authorizes any merge after independent review.**
