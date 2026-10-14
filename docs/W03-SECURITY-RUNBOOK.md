# W03 Security Runbook — Forge Eligibility Authority & Verified Builder Platform

Status: **sandbox only — `PRODUCTION_BLOCKED`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`, `FINCO_BURN_ENABLED=false`.**
Scope: `apps/forge-web` (W03). The W02 contracts are unchanged; their findings (F-03/F-04 owner powers etc.) stand.

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
- GitHub user tokens: AES-256-GCM at rest (purpose-bound key derived from `SESSION_SECRET`); only used server-side.
- SIWE: server-issued message, one-time nonce bound to session + GitHub id, domain/URI/chain bound, 5 min, atomic single use, EOA only, one active wallet per GitHub identity and vice versa.
- Webhooks: HMAC-SHA256 checked in constant time **before** parsing; delivery GUID persisted in the same transaction as the effects (exactly-once).
- Security headers: `X-Frame-Options: DENY`, `nosniff`, strict referrer, restrictive permissions policy.

## 5. Data integrity

- `verifications`: evidence immutable (trigger), only revocation columns may change, revocation is final.
- `evidence_receipts`, `audit_events`: append-only (trigger). Receipts are hash-chained and signed; `GET /api/proof/ledger` re-verifies the whole chain.
- Indexer: allowlist (Forge factory, its authorizer, registry, locker, and curves announced by that factory), event identity `(chainId, blockHash, logIndex)`, finality depth, reorg rollback, single-transaction commits.
