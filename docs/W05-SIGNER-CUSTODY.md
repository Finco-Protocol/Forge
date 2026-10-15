# W05 Signer Custody — KMS/HSM adapters, signer registry, signing-policy guard

Status: **sandbox only. Production signing is DISABLED.** `PRODUCTION_SIGNING_ENABLED = false` (new, `apps/forge-web/src/server/config.ts`), `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED = false`, `PRODUCTION_BLOCKED = true`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN = true`, `FINCO_BURN_ENABLED = false` are all unchanged or false.

**No real KMS or HSM was used.** The KMS adapters compile and were tested only against a fake AWS/GCP KMS (`apps/forge-web/test/helpers/fake-kms.ts`). The fake signs with `@noble/curves`, returns DER signatures that are deliberately high-s half the time, and returns OpenSSL-encoded SPKI public keys. The IAM material in `ops/iam/` is placeholders that were never applied. Section 10 lists the operator (Class B) work that remains.

## 1. Architecture

```
 caller (domain policy)            W05 guard                         custody
 ───────────────────────          ───────────────────────────       ─────────────────────────
 AuthoritySigner (policy.ts) ──┐
 revenue attestor (attestor.ts)├─► GuardedSigner(role) ──digest──► DigestSigner
 evidence ledger (proof/)    ──┘    typed data in, digest          ├ LocalTestDigestSigner (31337/1337 only)
                                    recomputed here                 └ KmsDigestSigner
                                                                        └ Secp256k1KmsBackend (injected)
                                                                           ├ awsKmsBackend (Sign/GetPublicKey)
                                                                           └ gcpKmsBackend (asymmetricSign/getPublicKey)
            SignerRegistry: builds custody, verifies at startup, owns the guards
```

- **Domain policy is unchanged.** `AuthoritySigner` still re-derives every BindingOp and EligibilityAttestation from durable and live chain state and records the outcome in `signing_requests`. The attestor still recomputes ceilings from finalised events. What changed is that both now pass the **typed data** to the guard instead of a digest.
- **The guard** (`src/server/signer/guard.ts`) is the only way into custody. `AppContext.evidenceSigner` and `AppContext.revenueAttestor` are now `GuardedSigner`s, and neither exposes a raw `signDigest`.
- **Custody** (`DigestSigner`) is unchanged: it signs a 32-byte digest and returns `r‖s‖v`.

### 1a. KMS adapter (`src/server/signer/kms/`)

| File | What it does |
| --- | --- |
| `backend.ts` | `Secp256k1KmsBackend`: `getPublicKeySpki()` and `signDigestDer(digest)`. These are the only two operations. There is no decrypt, import/export, create or delete call. |
| `aws.ts` | `AwsKmsSignClient`, shaped field-for-field on AWS SDK v3 `SignCommand` / `GetPublicKeyCommand`. Requests are `KeyId`, `Message` (exactly 32 bytes), `MessageType: "DIGEST"`, `SigningAlgorithm: "ECDSA_SHA_256"`. `GetPublicKey` must report `KeySpec ECC_SECG_P256K1`, `KeyUsage SIGN_VERIFY` and offer `ECDSA_SHA_256`. The KeyId format is validated. The answering KeyId is pinned to the configured key ARN, or to the first ARN seen when the config uses an alias. |
| `gcp.ts` | The GCP Cloud KMS shape: a `cryptoKeyVersions/N` name (never a bare key), algorithm `EC_SIGN_SECP256K1_SHA256`, and a PEM public key. It shares everything else. |
| `der.ts` | Strict DER decoding. SPKI must be `id-ecPublicKey` with `secp256k1` and an uncompressed point that lies on the curve. ECDSA-Sig-Value integers must be positive and minimally encoded, with `1 ≤ r, s < n`. Lengths must be definite and minimal, and no trailing bytes are allowed. |
| `signer.ts` | `KmsDigestSigner.create()` derives the address as `keccak256(X‖Y)[12:]` from custody's public key. It never trusts configuration for this. `signDigest` validates the digest, parses the DER, normalises low-s per EIP-2 (`s > n/2 → n − s`), and tries `v ∈ {27, 28}` against the known address. Exactly one must recover. Construction and every sign call are refused on chain 4663 and on every non-dev chain while `PRODUCTION_SIGNING_ENABLED=false`. |

**No cloud SDK is a dependency.** The process that enables KMS passes `createAppContext(env, { kms: (role, keyId) => awsKmsBackend(client, keyId) })`, where `client` is a two-line wrapper around the operator's own SDK client (see the comment in `aws.ts`). Without an injected backend, `FORGE_SIGNER_PROVIDER=kms` refuses to start.

## 2. Roles

| Role | Holder | Signs | Allowlist (guard) | On-chain holder checked at startup |
| --- | --- | --- | --- | --- |
| Eligibility authority | server, `local-test` or `kms` | EIP-712 `BindingOp` and `EligibilityAttestation` | `FINCO Forge Binding Registry` v2 at `registry` and `FINCO Forge Launch` v1 at `authorizer`, on the deployment chain, with the canonical struct definitions | `registry.eligibilityAuthority()` **and** `authorizer.eligibilityAuthority()` |
| Evidence signer | server | EIP-191 over one 32-byte receipt hash | `eip191-hash32` only | none |
| Revenue attestor | server (optional) | EIP-712 `EligibleRevenue` | `FINCO Forge Revenue Splitter` v1 at `revenueSplitter` | `splitter.revenueAttestor()` (`address(0)`, meaning revoked, also disables the role) |
| Relayer | server, in-process viem wallet | transactions only (pays gas) | not a custody role | must not equal any external address |
| Treasury recipient and governance | **external** (Safe). Never held by the server. | — | — | the server refuses to start if any server key equals the registry, authorizer, factory or splitter `owner()` or `pendingOwner()`, or `splitter.treasuryRecipient()` |

**Strict separation.**
- Authority, evidence, revenue attestor and relayer must all be distinct. This is checked in-process at startup, and the existing W03 and W04 error messages are kept.
- In the database, `signer_keys.address` is `UNIQUE`, so an address can be enrolled for one role only, ever.

## 3. Configuration

The default is unchanged: `FORGE_SIGNER_PROVIDER=local-test` with the `FORGE_*_PRIVATE_KEY` variables. All existing tests pass without modification. The one exception is `test/unit/migrate.test.ts`, which lists migration names and therefore now includes `004_signer_audit.sql`.

| Variable | Meaning |
| --- | --- |
| `FORGE_SIGNER_PROVIDER` | `local-test` (default) or `kms`. `kms` is refused on non-dev chains, refuses in-process authority/evidence/revenue keys, and needs an injected backend. |
| `FORGE_{AUTHORITY,EVIDENCE,REVENUE_ATTESTOR}_KMS_KEY_ID` | Key ARN, or GCP key-version name. Authority and evidence are required under `kms`; the revenue attestor is optional. |
| `FORGE_{AUTHORITY,EVIDENCE,REVENUE_ATTESTOR,RELAYER}_EXPECTED_ADDRESS` | Expected address. Required for every configured KMS key and optional for `local-test`. A mismatch disables the role; for the relayer, startup is refused. |
| `FORGE_SIGNER_KILL_SWITCH` | `authority,evidence,revenue` or `all`. Process-level kill switch. |
| `FORGE_SIGNER_ROLE_RATE_LIMIT_PER_HOUR` | Per-role custody rate limit (default 1000/h). This is on top of the existing per-repository and global AuthoritySigner limits. |

## 4. Startup verification (`src/server/signer/registry.ts`)

For each configured custody role, in order:

1. The address is derived from the provider: a local key, or KMS `GetPublicKey` → SPKI → address.
2. It must equal `FORGE_*_EXPECTED_ADDRESS` when that is set. It is required for KMS.
3. **Enrolment** in `signer_keys`:
   - If the key is the active version, it is accepted.
   - If it is retired or revoked, it is refused.
   - If it is enrolled for another role, it is refused.
   - If it is unknown and the role has no active version, it is enrolled as the next active version (first boot, or recovery after a revocation).
   - If it is unknown while another version is active, it is refused. Rotation is always explicit (section 6).
4. **On-chain:**
   - The authority must match **both** the registry and the authorizer.
   - The revenue attestor must match `splitter.revenueAttestor`.
   - Every server key (including the relayer) is compared with the external governance and treasury addresses.

A failure at steps 2–4 for a role **disables that role**: `status(role).enabled = false` with a reason, an `ALERT:signer_role_disabled` entry in `audit_events`, and a `console.error`. That role's guard refuses every request. Reads and the other roles keep working.

**The following refuse startup** instead of disabling a role:
- a server key that equals an external governance or treasury address;
- key overlap between server roles;
- KMS on a non-dev chain.

If the RPC is unreachable at startup, roles remain `unverified`. Each sign attempt re-runs the verification, and the role stays refused until verification succeeds. Unverified is never treated as verified.

Two kinds of disable (PR #5 Correction A):
- **Sticky** disables (custody violation, configured-address mismatch, key enrolment/version problems) last for the life of the process; after the operator fixes the cause, a restart re-verifies.
- **Chain-derived** disables (the on-chain authority or attestor does not name this key, or is revoked) are recomputed from a FRESH read on every signing request (`chainReason` in `registry.ts`). They clear on the next request only when the chain names the key again; a stale cached "verified" state never re-enables a role (see "Authority freshness policy" below).

## 5. Signing-policy guard (`src/server/signer/guard.ts`)

Each request goes through the following steps in order. Every outcome is appended to `signer_audit`, which is append-only and enforced by a trigger. Each row records the decision (`allowed`/`denied`/`failed`), the reason, role, signer address, key version, custody, payload kind, chain id, verifying contract, domain name and version, primary type, digest, idempotency key, `requested_by` and a **correlation id**.

1. **Allowlist.**
   - The domain must have exactly the fields name, version, chainId and verifyingContract (a `salt` is refused).
   - It must match the role's rule exactly. Chain id and contract come from this deployment.
   - The primary type must be allowed for the role.
   - The struct definitions must be structurally identical to the canonical ones, so a look-alike type with the same name is refused.
   - The message may contain no extra fields, and it must pass viem `validateTypedData`.
   - **The guard computes the digest itself** from the canonical types.
   - Chain 4663, and any chain other than 31337/1337, is refused while `PRODUCTION_SIGNING_ENABLED=false`. That check also covers EIP-191 payloads, which carry no chain id, through the deployment chain.
2. **Kill switch.**
   - The env `FORGE_SIGNER_KILL_SWITCH` is checked first.
   - Then `signer_kill_switch` for the role or `all` is read from the database **on every request**, so engaging it takes effect on the next request in every instance.
3. **Key version.** The signer's address must be the role's `active` version in `signer_keys`. `retired` and `revoked` keys never sign, and an unenrolled key never signs.
4. **Registry gate.** The role must not be disabled by startup verification (section 4).
5. **Rate limit.** A per-role fixed window using the existing `rateLimit()` in Postgres (`signer:<role>`).
6. **Replay and concurrency.**
   - `signer_signatures` has primary key `(role, digest)`. The first request inserts a `pending` claim with `INSERT … ON CONFLICT DO NOTHING`.
   - Concurrent identical requests wait for it and receive the **same stored signature**. This is audited as `allowed`, `replayed=true`. The result is one custody call per `(role, digest)`, ever.
   - A caller-supplied idempotency key is unique per role, so reusing it for a different payload is refused (`IDEMPOTENCY_KEY_REUSED`).
   - A digest signed earlier by a different key version is refused (`REPLAY_REFUSED`).
   - A custody failure deletes the claim and is audited as `failed`, so a retry can sign.
   - A claim older than 60 s, for example from a crashed instance, is taken over atomically.
7. **Custody.** The guard calls `inner.signDigest(digest)` and then checks that the signature recovers to the role's address before storing and returning it.

Two things the guard does not do:
- It does not replace the on-chain replay protection: registry op nonce and parent, attestation epoch and expiry, splitter per-asset nonce. Returning a stored signature for an identical digest is safe because it is the same authorization.
- There is a race between steps 2–4 and step 7. A kill switch engaged *during* an in-flight custody call does not cancel that call; it stops every later one.

## 6. Rotation and revocation

These are operator functions in `src/server/signer/controls.ts`. There is no HTTP endpoint for them. Every change is also written to `audit_events`.

| Operation | Effect |
| --- | --- |
| `rotateSignerKey(db, role, {address, custody, keyRef}, by, reason)` | Atomically sets the current `active` version to `retired` and inserts the new key as the only `active` version. A partial unique index allows at most one `active` key per role. A key is never reused. |
| `revokeSignerKey(db, role, address, by, reason)` | Sets the key to `revoked`. **The next sign is refused**, because status is read on every request. A key that was never enrolled is recorded as revoked so it can never be enrolled. An `ALERT:signer_key_revoked` entry is written. |
| Database triggers | `revoked` is terminal and `retired` never becomes `active` again. Identity columns are immutable and rows are never deleted. |

**On-chain rotation is separate and must match.**
- Authority: governance calls `setEligibilityAuthority` on **both** the registry and the authorizer (W03 runbook).
- Revenue attestor: `proposeRevenueAttestor` and then, after the 3-day timelock, `executeRevenueAttestorChange`.

The new server key can be enrolled before the on-chain switch, but the role is disabled at startup until the on-chain holder matches. Recommended order:
1. Create the new KMS key (ceremony).
2. `rotateSignerKey`.
3. Make the on-chain change.
4. Restart with the new `KMS_KEY_ID` and `EXPECTED_ADDRESS`.
5. Confirm that `status(role)` reports `verified`.

## 7. Kill switch

- **Database:** `engageKillSwitch(db, role | "all", by, reason)` and `releaseKillSwitch(...)`. These take effect immediately in every instance. The reason is included in every refusal.
- **Environment:** `FORGE_SIGNER_KILL_SWITCH=…`, effective at process start. Use it when the database itself is suspect.
- The kill switch only stops **new** signatures. Signatures already issued are stopped on chain by the procedures in section 8.

## 8. Incident procedures

### 8.1 Eligibility signer compromised (or its custody suspect)
1. `engageKillSwitch(db, "authority", …)`, or set `FORGE_SIGNER_KILL_SWITCH=authority` and restart. This stops new signatures immediately.
2. `revokeSignerKey(db, "authority", <address>, …)`. The key can never sign again on this deployment.
3. Governance (Safe): `setEligibilityAuthority(address(0))` on the **authorizer**. This bricks all launches and never opens them. Rotate on the registry. Then call `invalidatePendingOps(repoId)` for the affected repositories (W03 runbook §3).
4. In AWS: disable the KMS key with the break-glass admin role and MFA. Review CloudTrail `Sign` events for that key against `signer_audit` (correlation ids, digests). Any `Sign` without a matching `signer_audit` `allowed` row is a custody breach.
5. Recovery: create a new key in a ceremony, `rotateSignerKey`, run `setEligibilityAuthority(new)` on both contracts, restart, confirm `verified`, and release the kill switch.

### 8.2 Revenue attestor compromised
**`revokeRevenueAttestor()` does not erase headroom that is already authorized, but since PR #5 Correction A it pauses pulls in the same transaction** (and discards any pending rotation), so the headroom cannot be drained. `authorizeEligibleRevenue` reverts with `AttestorNotSet` and `pullRevenue` reverts with `PullsPaused`. Resuming pulls needs an explicit owner `setPullsPaused(false)`. Procedure (the former separate pause step is part of step 2):

1. `revokeSignerKey(db, "revenue", <address>, …)` and/or `engageKillSwitch(db, "revenue", …)`. The service stops signing immediately.
2. Governance (Safe) calls `revokeRevenueAttestor()` on the splitter. One atomic transaction: a compromised key's authorizations then revert with `AttestorNotSet`, any queued rotation is discarded, and pulls are paused, so the remaining headroom can no longer be pulled. `claimTreasury` and creator escrow claims **keep working**, because the pause only affects pulls.
3. Reconcile. Compare `EligibleRevenueAuthorized` events against `signer_audit` (`role='revenue'`) and against the recomputed eligible revenue (`attestor.ts`). Quantify any headroom above the recomputed value; it is third-party credit, not creator funds, and is bounded by the escrow balance under the splitter's key.
4. Recovery:
   - Create a new key.
   - `rotateSignerKey`.
   - `proposeRevenueAttestor(new)` (a NEW proposal; an earlier one was discarded by the revocation) and, after the 3-day timelock, `executeRevenueAttestorChange`.
   - Restart and confirm `verified`.
   - Unpause pulls (`setPullsPaused(false)`, owner only) only after review; executing a replacement does not unpause. The ceiling cannot be lowered on chain, so any over-authorized headroom becomes pullable again the moment pulls are unpaused.

This sequence is executed on anvil by `test/integration/signer-custody.test.ts` ("revenue-attestor incident"):
- authorize a ceiling with a KMS-signed `EligibleRevenue`;
- registry revocation, after which the next attestation is refused with no KMS call made;
- a rogue authorization from the still-live key simulates **OK** before the on-chain revoke;
- a pull of half the headroom **succeeds** (before the incident), and a pull above the remaining headroom reverts with `ExceedsVerifiedRevenue`;
- `revokeRevenueAttestor()`, after which the same authorization reverts with `AttestorNotSet` and every pull reverts with `PullsPaused` (no separate pause transaction);
- `claimTreasury` and the creator's escrow `claim()` both succeed.

### 8.3 Relayer key lost or compromised
The relayer only pays gas. Every registry operation and ceiling it relays is already signed by the authority or attestor, and replaying one fails on chain because of its nonce or parent. Loss stops relaying (revocation SLO, attestations), not safety.
1. Stop the worker or drain the relayer balance to an external address.
2. Generate a new gas key, fund it, and set `FORGE_RELAYER_PRIVATE_KEY` and `FORGE_RELAYER_EXPECTED_ADDRESS`. Restart.
3. If the old key is compromised, the attacker can only spend its gas balance and relay signatures that are already valid. If the revocation SLO is breached while the relayer is down, governance runs `invalidatePendingOps` (W03 §3).

### 8.4 Evidence signer compromised
Kill switch and revocation as in section 8.1. Receipts signed after the compromise time are suspect; append retractions. The key cannot affect eligibility or funds.

## 9. Production enablement (not done)
`PRODUCTION_SIGNING_ENABLED` and `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED` stay `false` in this change. Enabling them requires a separate, reviewed change after section 10 is complete, and that change must also lift the chain gates in `KmsDigestSigner`, the guard and `buildConfig`. `LocalTestDigestSigner` must **never** be enabled for non-dev chains.

## 10. Remaining Class B operator work
- **Provision real keys.** One `ECC_SECG_P256K1` / `SIGN_VERIFY` key per role, non-exportable (origin `AWS_KMS` or CloudHSM), single region. Use `ops/iam/kms-create-key.example.json`, in a recorded custody ceremony with two people, and record the derived addresses.
- **Apply IAM.** Apply the key policies and runtime-role policies from `ops/iam/`, the CloudTrail trail with KMS events, and the EventBridge alerts. Verify that a `Sign` call from any other principal is denied.
- **Wire the SDK.** Wire a real `AwsKmsSignClient` (or `GcpKmsClient`) into the process entry, and add timeouts and retries for throttling. This build has no cloud SDK, and **no real KMS endpoint has ever been called**.
- **Set addresses on chain.** Set the derived addresses on chain from governance: authority on the registry and authorizer, attestor on the splitter. Then confirm startup verification reports `verified`.
- **Monitoring.** Alert on `ALERT:signer_*` audit events and `signer_audit` denied/failed spikes. Reconcile CloudTrail `Sign` events against `signer_audit` every day.
- **Independent review.** Independent review of the adapters, the guard and this runbook. FINCO owner approval of the custody setup (W03 runbook §1 prerequisites).
- **Relayer custody.** Optional: a KMS relayer using a viem custom account that signs transaction digests through the same backend. It is not implemented.

## 11. Tests
- `test/unit/signer-kms.test.ts`:
  - SPKI parsing against OpenSSL-encoded keys, plus rejection of P-256 keys, compressed points, off-curve points, trailing bytes and non-minimal lengths.
  - DER parsing strictness.
  - OpenSSL's real high-s signatures normalised and recovered.
  - `KmsDigestSigner` over the fake AWS KMS: EIP-712 digests from the app's typed-data helpers, with output equal to the local RFC 6979 signature.
  - Refusal on chain 4663 and non-dev chains.
  - Validation of KeySpec, KeyUsage, answering KeyId, digest shape, and a custody that answers with the wrong key.
  - The GCP shape.
  - Role separation.
- `test/unit/signer-guard.test.ts`:
  - Allowlist acceptance and refusals: wrong chain, chain 1 and 4663, wrong contract, creator-only or other-role types, look-alike struct, `salt`, version, extra field, malformed message. In none of these cases is custody called.
  - Evidence and revenue allowlists.
  - Kill switches (database and env).
  - Rotation, retirement and revocation, and the immutability triggers.
  - The verification gate.
  - The rate limit.
  - 5 concurrent identical requests produce 1 KMS call.
  - Idempotency-key reuse.
  - Custody failure and retry.
  - `signer_audit` is append-only.
- `test/integration/signer-custody.test.ts` (anvil, real contracts, fake KMS for all three custody roles):
  - Startup verification succeeds.
  - An expected-address mismatch disables the role.
  - An on-chain attestor mismatch disables the role.
  - A treasury/governance key overlap refuses startup.
  - Key overlap, a non-dev chain, a missing backend, or in-process keys under `kms` all refuse startup.
  - A full launch whose KMS-signed BindingOp and EligibilityAttestation are verified by `ForgeBindingRegistry` and `ForgeLaunchAuthorizer`.
  - A KMS-signed Proof-of-Build receipt.
  - A KMS-signed `EligibleRevenue` accepted by `authorizeEligibleRevenue`.
  - The section 8.2 incident sequence.


## Authority freshness policy (PR #5 Correction A)

Startup verification is **not** a permanent authorization. Each signing request (every role, including `evidence`) performs one fresh on-chain snapshot read and decides from it:

| Check (per request) | Result when it fails |
|---|---|
| registry **and** authorizer `eligibilityAuthority` equal the authority key | `authority` refused (`mismatch`); accepted again only when the chain names the key again |
| splitter `revenueAttestor` equals the revenue key (`address(0)` = revoked) | `revenue` refused; same recovery rule |
| no server key (authority, evidence, revenue, relayer) equals any registry/authorizer/factory/splitter owner, pending owner or the treasury recipient | **sticky** custody violation: every role refused until restart + successful startup verification |
| any required read fails (RPC down, partial snapshot) | refused: fail closed (`unverified`) |
| durable key version `active`, kill switch off, allowlist, rate limit, replay claim | unchanged (read per request) |

Maximum staleness: **0 blocks** — there is no TTL and no cached "verified" flag. The only remaining window is the read→sign interval of a single request (plus chain finality). Cost: one multi-call snapshot per signature; signing is low-volume (launch authorizations, revenue attestations). Concurrency: every request decides from its own snapshot; an older snapshot can never overwrite newer persisted role state. Tests: `test/integration/w05-signer-freshness.test.ts` (11 tests; 9 of them fail against the previous registry).
