# W08 — Operator validation

Status: **BLOCKED for all real-operator items** — no live credentials, custody, governance or paging infrastructure exists in this environment, and none was invented. This file records, per operator item, what engineering rehearsal exists and what a real operator must do to close it.

| Item | Real requirement | Engineering rehearsal available (executed) | Missing for closure |
|---|---|---|---|
| B01 GitHub App | Register a real GitHub App on an isolated test org; install with least privilege (Metadata/Contents read-only); configure webhook + OAuth | FakeGithub-based suites: signature matrix, replay protection, narrowing events, rotation drill (all green in CI); operator setup checklist in `docs/W06-GITHUB-APP-ACCEPTANCE.md` | Real App credentials, webhook endpoint reachable by GitHub, real org |
| B02 KMS/HSM custody | Provision isolated KMS keys; verify identity/EIP-712/rotation/revocation; CloudTrail↔`signer_audit` reconciliation | fake-AWS-KMS rehearsal: `w06-governance-acceptance.test.ts` 13/13 (fail-closed RPC outage with zero custody calls, rotation, revocation, kill switch) | Real KMS + IAM policy + audit reconciliation |
| B03 Safe + timelock | Production Safe (≥3 owners, strict majority) + TimelockController (≥2 days) owning the contracts | Genuine Safe 1.5.0 + OZ Timelock on local Anvil: schedule/execute/cancel, delay enforcement, emergency revocation (CI) | Real multisig ceremony; ownership transfer execution |
| B04 Production RPC | Primary + fallback endpoints for chain 4663 | RPC-unavailable fail-closed drills (CI) + W08 compose RPC-outage drill | Operator-provisioned endpoints |
| B05 Deployment/treasury approval | Owner-approved deployment plan + treasury addresses | Dry-run planner (`w05:deploy-plan`, never broadcasts) | Owner sign-off + funded treasury |
| B06 Monitoring escalation | Alert routing + on-call contacts + test-page record | W07: 29 alert rules, all reachable through real events (`/api/ops/alerts`, `/metrics`); the compose drills exercise the underlying states | Routing destination, on-call contract, test-page record |
| B07 Production backup/restore | Production backup schedule + restore drill | W07 compose backup→restore with ledger-digest agreement — run 40278679711 @ `38aaa5d`, inherited as W07 engineering evidence (Correction A, review finding 4; NOT a current-W08 execution — the W08-HEAD compose run is recorded in W08-STAGING-RECOVERY.md once complete) — plus the `db:backup-rehearsal` suite (CI). **Executed on the final W08 head:** run 40592825745 @ `f4461cc` — reference = materialized = `ea2eae9a…9e01` on both databases, counts identical, migrations identical (earlier: 40290038031 @ `cce1d4a`, `7b310001…1052`) | Production backup infrastructure |
| B08 Real CREATE2 hook salt | Second-operator reproduction of the hook address | Salt-mask derivation tests | Real deployment |
| B09 Robinhood production-write acceptance | Controlled production write acceptance | Read-only probes + fork lifecycle (steps 7–9 deferred; A07e NOT_VERIFIED) | Owner authorization + production deployment (blocked behind B05) |

## Non-invention statement

No operator signature, approval record, on-call acknowledgment or credential was fabricated anywhere in W08. Every Class B item above remains open in `release/readiness-items.json` semantics, and the approver registry remains empty.
