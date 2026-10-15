# Free security review toolchain (Finco-Protocol/Forge only)

Scope: this repository only. Nothing here touches another repository of the organisation, deploys, signs or merges.
The independent reviewer keeps final approval authority; none of these tools is an audit (C01 stays open).

## 1. What runs, what needs an administrator

| Tool | Where | Status | Needs admin? |
|---|---|---|---|
| **Slither 0.11.6** (Solidity) | `.github/workflows/security-toolchain.yml` job *Solidity* | runs on PR/push/weekly | no |
| **Aderyn 0.6.8** (Solidity) | same job | runs | no |
| **Semgrep CE 1.181.0** (TS/Next.js/Python/workflows) | job *application* | runs; community packs + `semgrep/forge-rules.yml`; **no Semgrep token, metrics off** | no |
| **Unified report + policy gate** | job *report* | runs; artifact `security-unified-report` | no (add as a *required check*: admin) |
| **SARIF → GitHub code scanning** | `upload-sarif` steps (categories `slither`, `aderyn`, `semgrep`) | attempted every run; outcome printed in the job summary (`continue-on-error`, so an unsupported plan/fork never hides scanner results) | needs Code Security/Code scanning available for the repo |
| **CodeQL** | settings (default setup) | **not enabled** (no `CodeQL` dynamic workflow exists on 2026-10-15) | **yes** |
| **CodeRabbit** | `.coderabbit.yaml` | config committed (validated against CodeRabbit's published `schema.v2.json`, 0 errors); **not installed** | **yes** |
| **SonarQube Cloud** | `sonar-project.properties`, `.github/workflows/sonarqube-cloud.yml` | config committed; workflow reports `SONARQUBE_CLOUD_NOT_CONNECTED` and analyses nothing until connected | **yes** |

### Administrator steps (committing files does not install anything)
1. **CodeQL** – Settings → Code security → *Code scanning* → CodeQL analysis → **Set up → Default**, for **this repository only**. Languages: JavaScript/TypeScript, Python, GitHub Actions. CodeQL does not analyse Solidity (Slither/Aderyn do). Do **not** also add an advanced CodeQL workflow (`.github/codeql/codeql-config.yml` is ready if the administrators prefer advanced setup instead; disable default setup first). The report job prints the live default-setup state.
2. **CodeRabbit** – install the CodeRabbit GitHub App with *Only select repositories → Forge*. The committed `.coderabbit.yaml` then applies (drafts are reviewed; Solidity/auth/finance path instructions). It is advisory.
3. **SonarQube Cloud** – import **only** `Finco-Protocol/Forge` (no organisation-wide import), then set the secret `SONAR_TOKEN` and repository variables `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY`. No key or token is invented in the repository. Free-plan analysers cover TS/JS/Python/workflows; Solidity is excluded in `sonar-project.properties`.
4. Make **`security: unified report + policy gate …`** a required status check (branch protection / ruleset) so new critical/high findings in Forge-owned code block the merge.

## 2. Solidity coverage and scope classification
Slither compiles the approved Foundry profile `forge` (solc 0.8.35, pinned in `foundry.toml`) once and analyses the **full dependency graph**; findings in vendored paths (`contractsV2-deployed/lib`, `contractsV2/lib`) and `test-forge` are analysed but not reported. Aderyn ingests `contractsV2-forge/src`. Every finding is attributed to exactly one scope (`security/report.mjs`):

| Scope | Meaning | Blocks on NEW critical/high |
|---|---|---|
| `forge-authorization` | `ForgeBindingRegistry`, `ForgeLaunchAuthorizer`, `IForgeLaunchAuthorizer` | yes |
| `forge-revenue-treasury` | `ForgeProtocolRevenueSplitter`, `IFincoBurnReserveExecutor` | yes |
| `forge-modified-pons` | lines within 10 lines of a Forge change in a PONS-derived file that differs from `contractsV2-deployed` (today only `PonsV2LaunchFactory.sol`) | yes |
| `inherited-pons` | files byte-identical to the deploy-time tree, and untouched lines of modified files | no (reported and triaged; changing them would invalidate deployed-source evidence) |
| `vendored-dependency` | OpenZeppelin, Uniswap v4, Permit2 … | excluded |
| `forge-new-other`, `app-forge`, `app-scripts`, `ci-workflow` | other Forge-owned code | yes |

## 3. Application coverage (Semgrep CE)
Scanned: `apps/forge-web/src` (API routes, auth, GitHub OAuth/webhooks, SIWE, EIP-712 signing, KMS, revenue attestor, ledger, PostgreSQL), `apps/forge-web/scripts` (deployment tooling), `scripts/`, `security/`, `.github/` (workflows). Packs: `p/typescript p/nextjs p/github-actions p/secrets p/owasp-top-ten p/jwt p/python` plus eight project rules (`semgrep/forge-rules.yml`, each with flagged and clean fixtures run by `semgrep --test` in CI): SQL string interpolation, `signDigest` outside the custody layer, secrets in logs, hard-safety-flag changes (`FINCO_BURN_ENABLED`, `DEPLOY_WRITE_ENABLED`, `PRODUCTION_SIGNING_ENABLED`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED` set true; `PRODUCTION_BLOCKED` set false), XSS sinks, dynamic code execution, non-constant-time secret comparison.
Coverage gap (reported, not hidden): Semgrep could only partially parse `apps/forge-web/src/app/projects/[token]/page.tsx`.

## 4. Unified report
`node security/report.mjs …` normalises all scanners into `security-report.json` / `.md` with: scanner, exact tool version, exact commit analysed, scope, severity, priority (P0 critical, P1 high, P2 medium, P3 low/info), rule, file:line, evidence, classification (`confirmed-vulnerability | confirmed-issue | false-positive | by-design | informational | inherited-accepted | untriaged`), baseline-vs-new, disposition (`open | accepted | resolved`), required fix. Exit codes: 0 pass, **1 new critical/high in Forge-owned code**, **2 scanner crash / missing or invalid report / invalid config**.

Policy:
* A scanner that crashed, produced no/invalid report, or whose job did not succeed is a **failure**, never a clean scan (Slither runs with `--fail-none` precisely so that *findings* do not look like crashes; the report checks `success=true`).
* Triage lives in `security/baseline.json`: one entry **per finding fingerprint** (rule + file + normalised source line + occurrence), each with classification, disposition, reason (≥ 20 chars) and required fix. Wildcard / rule-wide suppression is rejected by the validator; a changed line or a new instance is a NEW finding. Entries are generated from `security/triage-decisions.json` by `node security/make-baseline.mjs` (an unmatched finding aborts, forcing an explicit decision). Every entry is a **proposal by the implementing agent until an independent reviewer approves it** (`reviewStatus`).
* Stale baseline entries (finding fixed or moved) only warn.

## 5. Findings at the analysed tree
The first CI run on the PR head is authoritative (artifact `security-unified-report`); the local run on the same sources gave:

| | Slither | Aderyn | Semgrep | total |
|---|---|---|---|---|
| findings | 136 | 163 | 101 | 400 |

By severity: critical 0 · high 50 · medium 130 · low 185 · info 35. By scope: inherited-pons 216 · ci-workflow 89 · forge-revenue-treasury 46 · forge-authorization 34 · app-scripts 7 · app-forge 5 · forge-modified-pons 3. New (un-triaged) findings: 0. Blocking: 0.

Triage outcomes:
* **Confirmed and FIXED in this change (P1):** `gcm-no-tag-length` in `apps/forge-web/src/server/crypto.ts` – AES-256-GCM decryption did not pin the auth-tag length (Node accepts truncated tags ⇒ practical forgery). Now `authTagLength: 16` on both sides plus an explicit length check; tests `security-crypto.test.ts`. Not in the baseline.
* **Hardened:** `revokeUserVerifications()` `where` parameter narrowed to a literal union (the SQL-interpolation rule still flags the splice; documented as by-design).
* **Confirmed, open (P2, supply chain, 89 entries):** `github-actions-mutable-action-tag` – actions are referenced by mutable tag, not full commit SHA (71 pre-existing + 18 in the new workflows). Required fix: pin every `uses:` to a commit SHA and let Dependabot/Renovate bump them. Not done here because SHAs cannot be resolved from this sandbox without reading other repositories.
* **Forge-owned Solidity highs (12 in the splitter, all false positives / by-design):** `arbitrary-send-eth` (`_send` pays only the fixed treasury recipient, nonReentrant, effects first), `reentrancy-balance` ×2 (`pullRevenue` is nonReentrant, calls only the canonical escrow, balance-delta accounting, `_pullingNative` gate), Aderyn `reentrancy-state-change` ×7 (view calls before guarded writes / the guard flag itself), `storage-array-memory-edit` ×2 (`_matured` reads a memory copy, storage cleared with `delete`). Each is its own baseline entry with that reason.
* **Inherited PONS (216):** byte-identical to the deploy-time tree – accepted as *inherited*, **not** exploit-triaged by Forge, deferred to the external audit C01 and PONS Labs (`docs/SECURITY-REVIEW.md`).
* **Modified PONS (3):** factory constructor wiring check (false positive), `_exemptFromSnipeTax` call loop (inherited behaviour, by design).

## 6. CI cost control
Path detection skips the Solidity job unless `contractsV2-forge/`, `foundry.*`, `contractsV2-deployed/` or the toolchain changed and the Semgrep job unless app/scripts/workflow/toolchain paths changed (push to `main`, the weekly schedule and manual runs scan everything). One Foundry compile serves Slither and Aderyn; no test suite is run inside the scanner jobs.

## 7. Remaining
External audit (C01), F-03/F-04 review (C03), legal (C04–C06), CodeQL/CodeRabbit/SonarQube Cloud administrator connection, branch-protection required check, SHA-pinning of actions, independent review of the proposed baseline.
