# 8. Security scanner results

**Slither, Aderyn, Semgrep and CodeRabbit are not an audit.** None of them replaces an independent smart-contract review, and `docs/SECURITY-TOOLCHAIN.md` says so itself ("none of these tools is an audit; C01 stays open"). SonarQube Cloud is not connected (`SONARQUBE_CLOUD_NOT_CONNECTED`) and CodeQL is not enabled, so neither produced results.

**The baseline is not self-approved and is not security acceptance.** `security/baseline.json` was written by the implementing agent. Its `reviewStatus` is `PROPOSED_BY_AGENT_PENDING_INDEPENDENT_REVIEW`, it carries no `review` block, and the tooling's own function `baselineAcceptance()` (`security/report.mjs`) returns ``{ status: "UNREVIEWED", granted: false }`` for it (RAN for this dossier). A review block would have to carry `{approvedBy, approvedAt, entriesSha256}` with a digest of the current entries; nothing in tooling or CI ever writes it. Also, `generatedFrom.commit` in the file is the literal string `regen`, so the baseline is not bound to a commit SHA.

## 8.1 Numbers (from `security/baseline.json`, RAN)

Tool versions recorded: Slither 0.11.6, Aderyn 0.6.8, Semgrep 1.181.0. 302 findings, each with its own fingerprint.

| Dimension | Counts |
| --- | --- |
| By scanner | Aderyn 163, Slither 136, Semgrep 3 |
| By severity | high 41, medium 41, low 185, info 35 |
| By scope | `inherited-pons` 216, `forge-revenue-treasury` 46, `forge-authorization` 34, `forge-modified-pons` 3, `app-forge` 3 |
| By classification | `inherited-accepted` 216, `by-design` 43, `false-positive` 22, `informational` 21, `confirmed-issue` 0, `confirmed-vulnerability` 0 |
| By disposition | `accepted` 302; `open` 0; `resolved` 0 |
| Computed triage status (`triageStatus`) | `DEFERRED_EXTERNAL_AUDIT` 216 (all inherited PONS), `ACCEPTED` 64 (Forge-owned), `FALSE_POSITIVE` 22 (Forge-owned), `OPEN` 0 |
| Open high/critical | **0** (Forge-owned 0, inherited 0) |

Read "0 open high" with its context:

- All 302 dispositions are `accepted` because the implementing agent accepted them. No finding is `open`, and **there is no independent triage**.
- 41 findings are high severity. Their status: 25 in inherited PONS code (`DEFERRED_EXTERNAL_AUDIT`, "NOT exploit-triaged by Forge", deferred to external audit C01), 13 Forge-owned classed `FALSE_POSITIVE` (12 in the splitter, 1 in the factory constructor), and 3 Semgrep `by-design` items in `apps/forge-web/src/server/github/webhooks.ts` (SQL interpolation of constant fragments; application code, not Solidity).
- The 25 inherited high findings sit in unmodified deploy-time PONS contracts, which Forge cannot patch without invalidating the deployed-source evidence. They are exactly the code an auditor must triage first-hand.
- The policy gate (`security/report.mjs`) blocks on **new** critical/high findings in Forge-owned scopes (`BLOCKING_SCOPES`) and treats a stale or absent baseline fingerprint as new. It does not block on inherited findings.

## 8.2 Forge-owned Solidity findings, by category (86 Forge-owned entries; 83 are Solidity, listed here exactly)

| Rule | Scanner | Severity | Count (by scope) | Triage rationale recorded in the file |
| --- | --- | --- | --- | --- |
| `centralization-risk` | aderyn | low | 15 (authorization 5, revenue-treasury 10) | owner-gated functions are the documented governance model; each is in the authority matrix; standing powers disclosed (F-03/F-04/W05-03); `requiredFix`: external review C03 |
| `literal-instead-of-constant` | aderyn | low | 9 (authorization 7, revenue-treasury 2) | style note |
| `timestamp` | slither | low | 9 (authorization 3, revenue-treasury 6) | deadlines and 3-day timelocks intentionally use `block.timestamp` |
| `reentrancy-state-change` | aderyn | high | 8 (modified-pons 1, revenue-treasury 7) | "external calls" before state writes are view reads in owner-only `setAssetApproved` / `authorizeEligibleRevenue`, or the guarded escrow claim inside `nonReentrant` `pullRevenue`; for the factory it is the constructor wiring check `positionManager_.poolManager()` |
| `push-zero-opcode` | aderyn | low | 5 (authorization 3, revenue-treasury 2) | `PUSH0` is intended for the cancun target |
| `unspecific-solidity-pragma` | aderyn | low | 5 (authorization 3, revenue-treasury 2) | compiler is pinned to 0.8.35 by profile `forge` regardless of the `^` pragma |
| `uninitialized-local` | slither | medium | 4 (authorization 4) | `requireAuthorizedLaunchCall` declares decoded parameters up front and assigns each by tuple destructuring in every non-reverting branch |
| `cyclomatic-complexity` | slither | info | 3 (authorization 2, revenue-treasury 1) | complexity is in signature-verification / attestation paths covered by the M-ELIG and splitter suites |
| `calls-loop` | slither | low | 2 (modified-pons 2) | `_exemptFromSnipeTax` calls the curve once per exemption (creator-supplied, bounded to 32); inherited PONS behaviour |
| `incorrect-equality` | slither | medium | 2 (revenue-treasury 2) | `received == 0` / `amount == 0` are sentinel checks on locally computed values |
| `low-level-calls` | slither | info | 2 (revenue-treasury 2) | the checked ETH transfer in `_send` and the ArbSys `staticcall` in `_evidenceView` (length/success validated) |
| `reentrancy-balance` | slither | high | 2 (revenue-treasury 2) | `pullRevenue` is `nonReentrant` and calls only the canonical escrow; the native leg re-enters only `receive()`, gated by `_pullingNative`; amounts are balance deltas |
| `reentrancy-benign` | slither | low | 2 (revenue-treasury 2) | as `pullRevenue` above |
| `shadowing-local` | slither | low | 2 (authorization 2) | local names shadow OpenZeppelin helpers |
| `storage-array-memory-edit` | aderyn | high | 2 (revenue-treasury 2) | `_matured(pending*)` takes a memory copy only to read fields; the storage struct is then cleared with `delete` |
| `unchecked-return` | aderyn | low | 2 (revenue-treasury 2) | escrow `claim` / `claimToken` return values intentionally ignored; receipt measured by balance delta and bounded by the ceiling |
| `unused-return` | slither | medium | 2 (revenue-treasury 2) | escrow return values intentionally ignored (balance-delta accounting) |
| `arbitrary-send-eth` | slither | high | 1 (revenue-treasury 1) | `_send` is private, after state updates, `nonReentrant`, and pays only the fixed treasury recipient (claim) or the `releaseNonRevenue` recipient (= treasury) |
| `assembly` | slither | info | 1 (authorization 1) | one `memory-safe` block in `_authorize` that unpacks the 81-byte attestation payload |
| `missing-zero-check` | slither | low | 1 (authorization 1) | `setEligibilityAuthority(address(0))` is the deliberate launch kill switch |
| `reentrancy-no-eth` | slither | medium | 1 (revenue-treasury 1) | as `pullRevenue` above |
| `require-revert-in-loop` | aderyn | low | 1 (authorization 1) | the loop validates a caller-supplied array (zero-address refusal in `canonicalExemptionHash`) |
| `state-no-address-check` | aderyn | low | 1 (authorization 1) | `address(0)` authority is the deliberate kill-switch state of `setEligibilityAuthority` |
| `unused-public-function` | aderyn | low | 1 (authorization 1) | style note |

(Counts are exact groupings of `security/baseline.json` entries with a `.sol` file and a non-`inherited-pons` scope. The authoritative per-finding rows, each with fingerprint, file, line, anchor text, classification and reason, are in that file; "authorization" = `forge-authorization`, "revenue-treasury" = splitter scope, "modified-pons" = the factory.)

**Not covered by the scanners:** `test-forge/**`, mocks and all vendored libraries (analysed but not reported), the deploy-time tree as a standalone (covered as `inherited-pons` through the Forge profile), and any logic-level property. The scanners did not report the observations in `PRIVILEGED-AUTHORITIES.md` 4.5 (authority-key rotation without timelock) or the `blockhash` assumption in `ROBINHOOD-CHAIN-RISKS.md` 7.1.

## 8.3 Decisions that are not baseline entries

`security/triage-decisions.json` (22 decisions; "first matching decision wins"; each a *proposal by the implementing agent*) includes one `confirmed-issue / open` decision that matches **no** baseline entry: Semgrep `github-actions-mutable-action-tag` (actions referenced by mutable tag). At this SHA every `uses:` line in `.github/workflows/*.yml` is pinned to a 40-hex commit SHA (RAN: grep found none unpinned), so the decision is dormant; `docs/SECURITY-TOOLCHAIN.md` section 7 still lists "SHA-pinning of actions" as remaining, which is stale (KNOWN-DISCREPANCIES D14).

## 8.4 The release findings register (`release/security-findings.json`, 15 entries)

| Status | Entries |
| --- | --- |
| `fixed` (6) | F-01 (critical), F-02 (high), W05-01 (high), W05-05 (high), W05-06 (high), W05-07 (medium) |
| `disclosed-owner-trust` (7) | F-03 (high), F-04 (high), F-05 (medium), W05-02 (medium), W05-03 (medium), W05-04 (low), W05-08 (low) |
| `open` (2) | F-07 (medium; no external audit covers the current code, `C01`), F-09 (medium; BUSL-1.1 legal review, `C04`) |
| `accepted-by-external-review` | none: no external reviewer has accepted anything; `release/approver-registry.json` has empty `operatorKeys` and `externalApproverKeys` |

How the gate reads it (`apps/forge-web/src/release/gate.ts`): only a finding with severity critical/high **and status `open`** fails the gate. F-03 and F-04 are high severity but are recorded as `disclosed-owner-trust`, not `open`, so they do not trip the "open high" check even though no one has approved them. An auditor should not infer from "0 open high" that high-severity risks are absent; they are present, disclosed and unaccepted.

`fixed` for F-01/F-02 means: the **recovered deploy-time tree plus the byte-parity gate** replaced the non-compiling upstream tree as the build basis (W02). It does not mean the upstream git HEAD (`contractsV2/`) was repaired; it still does not compile, by design a canary (KNOWN-DISCREPANCIES D8).

## 8.5 CodeRabbit

`.coderabbit.yaml` is committed (Forge repository only; advisory). `docs/SECURITY-TOOLCHAIN.md` records the App as installed and active on the repository (observed on PR #5); its comments are not a source of findings in this dossier and were not collected. CodeRabbit's "Autofix" is deliberately left off.

## 8.6 Reproducing the scanner run

CI job `Security toolchain` (`.github/workflows/security-toolchain.yml`) pins the three tool versions; the unified report is `node security/report.mjs --root . --commit "$(git rev-parse HEAD)" --out-dir security-report --baseline security/baseline.json --slither slither.json --aderyn aderyn.json --semgrep semgrep.json --versions slither=0.11.6,aderyn=0.6.8,semgrep=1.181.0` (`security/README.md`). Slither runs against `out/forge` from `forge build --profile forge`; Aderyn against `contractsV2-forge/src`. This dossier did **not** run any scanner.
