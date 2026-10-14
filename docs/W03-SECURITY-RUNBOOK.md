# W03 Security Runbook — Forge Eligibility Authority & Verified Builder Platform

Status: **sandbox only — `PRODUCTION_BLOCKED`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`, `FINCO_BURN_ENABLED=false`.**
Scope: `apps/forge-web` (W03) plus the W03 Correction A change to the Forge factory/authorizer (calldata-forwarded authorization, docs/MODIFICATION-REGISTER.md §7). W02's findings (F-03/F-04 owner powers etc.) stand.

## 1. Keys and roles

| Role | Holds | Can | Cannot |
| --- | --- | --- | --- |
| Eligibility authority | secp256k1 key whose address is `eligibilityAuthority` in **both** `ForgeBindingRegistry` and `ForgeLaunchAuthorizer` | sign `BindingOp` and `EligibilityAttestation` | launch anything on its own (creator consent required; the authorizer rejects a single key signing both) |
| Relayer | gas-paying EOA | submit already-signed registry ops | sign anything with authority |
| Evidence signer | separate key | sign Proof of Build receipts (EIP-191 over receipt hash) | affect eligibility |
| Governance (owner) | owner of registry/authorizer/factory | rotate authority (both contracts in one batch), `invalidatePendingOps`, kill switch `setEligibilityAuthority(0)` | — (F-03/F-04 owner powers on the factory remain; see SECURITY-REVIEW) |

All three service keys must be distinct (enforced at startup).

### Custody

- `src/server/signer/types.ts` defines `DigestSigner`: sign a 32-byte digest → 65-byte `r‖s‖v`. That is exactly what AWS KMS (`ECC_SECG_P256K1`, `MessageType=DIGEST`), GCP KMS or an HSM expose. Custody never sees structured data.
- W03 ships **only** `LocalTestDigestSigner`, which refuses to construct for any chain except 31337/1337 and always for 4663.
- **Production activation requires all of:** a KMS/HSM `DigestSigner` adapter, independently reviewed; key generated inside custody (non-exportable); IAM restricted to the worker/API role (sign only, no key admin); a separate reviewer approving the custody setup; FINCO owner approval recorded; W04 sign-off. None of this exists yet.

## 2. Signing policy (`src/server/signer/policy.ts`)

Before any digest reaches custody, the policy re-derives the request from durable and live chain state:

- **BindingOp (bind):** a verification record that is fresh (≤ `FORGE_VERIFICATION_TTL_SECONDS`), unrevoked, has admin from **both** the user token and the installation view, matches repo id, wallet and repository name, and is tied to an **active** wallet binding. Repository not ineligible. `opNonce == opSequence+1` and `parentOpDigest == headOpDigest`, read live (Correction B; obsolete sequences/parents are refused). Deadline ≤ 10 min and horizon ≤ policy. The digest is recomputed locally **and** compared with `attestationDigestForBindingOp`.
- **BindingOp (revoke):** only the current, active binding's creator; a reason is required. Revocation can only narrow eligibility.
- **EligibilityAttestation:** same verification checks; the registry binding must be active for the creator; `bindingEpoch` must equal the live epoch; `issuedAt ≤ now`, lifetime ≤ policy (≤ 3 days); expiry ≤ binding horizon; digest parity with `attestationDigest`.
- Per-repo and global rate limits; every decision (allowed **and** denied) is written to `signing_requests`. No HTTP endpoint accepts caller-chosen data to sign.

## 3. Incident playbooks

### 3.0 Revocation model — what is and is not guaranteed

Revocation has two layers with different guarantees:

1. **Off-chain refusal: immediate.** The webhook (or reconciliation) marks the repository ineligible, revokes its verification records and supersedes unsigned intents in the same database transaction. From that moment the authority refuses to sign any `BindingOp`/`EligibilityAttestation` for it (policy check: "verification revoked" / "repository ineligible"), and the API refuses new authorizations and signatures.
2. **On-chain revocation: a confirmed transaction, not instantaneous.** A `registry_revoke` job (priority 0, ahead of all other worker work, run *before* indexing on every pass) signs a revoke op against the live registry head and relays it, then waits for the receipt at the configured confirmation depth. The job is marked done only when a fresh registry read shows no active binding for that creator.

**Residual risk (contract-level, cannot be closed by W03):** between (1) and the confirmation of (2), an attestation issued *before* the revocation (lifetime ≤ `FORGE_ATTESTATION_TTL_SECONDS`, default 30 min, hard cap 3 days) plus a creator consent signed *before* it can still execute a launch, because the authorizer only checks `registry.isActive` at launch time. Lowering `FORGE_ATTESTATION_TTL_SECONDS` shrinks this window; governance can close it immediately with `invalidatePendingOps(repoId)` (below).

**Durability and alerts.**
- Critical jobs (`registry_revoke`, `repo_revalidate`) are never dropped: unlimited retries, backoff `min(60 s, 2^attempt s)`. After 3 failed attempts an `ALERT:revocation_retrying` audit event is written (once per job). Non-critical jobs stop after 8 attempts with `ALERT:job_failed_permanently`.
- Watchdog (every worker pass): every repository the service invalidated, and every confirmed binding whose creator has no active wallet binding, must be inactive on chain. If not (missed job, or a confirmed revoke later **reorged out**), a new revoke job keyed by the live registry sequence is enqueued and `ALERT:revocation_not_final` is written.
- Never-landed registry ops (failed, or signed/submitted past their deadline and not consumed on chain per `usedOps`) are settled as `failed`/`abandoned` and no longer block a retry of the same slot. On chain, ops for one `(sequence, parent)` slot remain mutually exclusive (Correction B).

**SLO and monitoring.** `GET /api/health` returns `revocations = { pending, oldestPendingSeconds, retrying, lastLatencySeconds, sloSeconds, breached }`. Target: on-chain revocation confirmed within `FORGE_REVOCATION_SLO_SECONDS` (default 300 s) of the triggering event. Page on `breached = true` or any `ALERT:*` audit event. Measured in the sandbox: sub-second (single worker pass, 1 confirmation).

**Emergency path — `invalidatePendingOps(repoId)`.** Callable by the eligibility authority or the registry owner (governance). It revokes the active binding and moves the op-log head to an unpredictable barrier digest, killing every outstanding signed op for the repo; it can only narrow eligibility. W03 deliberately does **not** let the service call it with the authority key: that would require the authority key to sign *transactions* (a second key usage beyond EIP-712 digests, needing gas on the authority address). The signed revoke op already moves the head and kills pending ops for the normal path. Use `invalidatePendingOps` from the **governance multisig** when (a) the authority key or its custody is suspect, or (b) the service/relayer path is down and the SLO is breached. Neither path invalidates an already-issued attestation by itself; only the resulting `isActive == false` does.

| Event | Immediate action | Automated? |
| --- | --- | --- |
| Repo transferred / archived / deleted / removed from installation / App uninstalled | webhook → repository marked ineligible, verifications revoked, unsigned intents superseded, `registry_revoke` job → authority-signed revoke on chain | yes (worker) |
| Missed webhook | reconciliation (`reconcileAll`, every 10 min) re-checks every active on-chain binding via the installation token and revokes on loss | yes |
| User revokes wallet binding | verifications for that wallet revoked; registry bindings naming it revoked on chain | yes |
| Suspected authority-key compromise | governance: `setEligibilityAuthority(address(0))` on the **authorizer** (bricks all launches; never opens them) and rotate on the registry; then `invalidatePendingOps(repoId)` for affected repos | manual |
| One outstanding signature must die now | governance or authority: `invalidatePendingOps(repoId)` (barrier digest; kills every pending op for the repo) | manual |
| GitHub outage | verification fails closed (no new attestations); existing bindings are **not** revoked by an outage | by design |
| Reorg deeper than `FORGE_INDEXER_REORG_WINDOW` | indexer halts with `REORG_DEEPER_THAN_WINDOW`; investigate, then rewind the checkpoint manually below the fork point | manual |
| Webhook secret leak | rotate in the GitHub App and `GITHUB_WEBHOOK_SECRET`; deliveries are idempotent by GUID | manual |

## 4. Web security controls

- Sessions: 256-bit random token in an HttpOnly, SameSite=Lax (Secure on https) cookie; only `sha256(token)` is stored; rotated when a GitHub identity attaches (fixation defence); per-session or all-session revocation.
- CSRF: every state-changing request needs `Origin == FORGE_PUBLIC_ORIGIN` **and** `x-forge-csrf == HMAC(SESSION_SECRET, sessionIdHash)`.
- OAuth `state`: random, sha256-stored, bound to the session, single use, 10 min.
- **Trusted-proxy policy.** `X-Forwarded-For` is client-controlled. With `FORGE_TRUSTED_PROXY_HOPS=0` (default) it is never read; with `N > 0` the client address is the N-th entry from the right (the one appended by our outermost trusted proxy), everything to its left is ignored, and a header with fewer than N entries yields "no trusted address". Deploy behind exactly N proxies that append (not overwrite) the header, and strip it at the edge.
- **Rate limits.** Identity-bearing limits key on durable identifiers (GitHub user id for discovery/verification/SIWE/drafts/eligibility; repository id for authority signing; global per kind). Unauthenticated limits (OAuth start) key on the trusted client address when one exists, otherwise on the anonymous session, and always also on a global ceiling — spoofed headers cannot multiply the budget. Without a trusted proxy a spoofing client is bounded only by the global ceiling (600 OAuth starts / 10 min), which is the accepted trade-off; configure the proxy hops in production. Counters are atomic upserts in Postgres (parallel requests cannot exceed the limit).
- GitHub user tokens: AES-256-GCM at rest (purpose-bound key derived from `SESSION_SECRET`); only used server-side.
- SIWE: server-issued message, one-time nonce bound to session + GitHub id, domain/URI/chain bound, 5 min, atomic single use, EOA only, one active wallet per GitHub identity and vice versa.
- Webhooks: HMAC-SHA256 checked in constant time **before** parsing; delivery GUID persisted in the same transaction as the effects (exactly-once).
- Security headers: `X-Frame-Options: DENY`, `nosniff`, strict referrer, restrictive permissions policy.

## 5. Data integrity

- `verifications`: evidence immutable (trigger), only revocation columns may change, revocation is final.
- `evidence_receipts`, `audit_events`: append-only (trigger). Receipts are hash-chained and signed; `GET /api/proof/ledger` re-verifies the whole chain.
- Indexer: allowlist (Forge factory, its authorizer, registry, locker, and curves announced by that factory), event identity `(chainId, blockHash, logIndex)`, finality depth, reorg rollback, single-transaction commits.
