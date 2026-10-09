# Forge Change Map — design only (no implementation in this PR)

Minimal design for the Forge-specific additions defined by the FINCO Forge
Implementation Blueprint. **Nothing here is implemented in this PR**; the
FINCO token itself will initially launch externally through the ORIGINAL
PONS V2 factory, no second FINCO token is issued, and
`FINCO_BURN_ENABLED=false`.

> **Correction A (authority & economics) status flags:**
> `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN` — the intended Forge fee policy is
> NOT executable from reviewed source today (§6). GitHub-verified launches
> are NOT enforceable on the original PONS factory without either PONS-owner
> cooperation or a factory-level modification that has not been built or
> reviewed (§4.4). The 70/20/10 figure used anywhere below is ILLUSTRATIVE
> ONLY and is not implemented anywhere.

## 0. Two factories, two tracks — the authority boundary

| | **Original PONS V2 factory** | **Forge-owned factory** |
| --- | --- | --- |
| Address | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (chain 4663) | **Does not exist yet** |
| Operator | PONS Labs (their owner `0x263e…19Dd`, admin powers per docs/SECURITY-REVIEW.md F-03/F-04) | FINCO governance (timelocked multisig, to be constituted) |
| Purpose | PONS' own product. **FINCO's initial FINCO token issuance runs here as an external user** | The only venue for third-party GitHub-verified token launches under the Forge brand |
| Forge administrative assumptions | **NONE.** Forge must not assume, request, or depend on any configuration change by the PONS owner: no whitelist slots, no forwarder wiring, no launch-gate closure. Whatever FINCO can do there, an ordinary permissionless user can do | Full: Forge deploys, configures, owns and governs it |
| Blockers | Out of scope for this repository (see docs/SECURITY-REVIEW.md F-01/F-02 for why even using it as a user carries unresolved-risk caveats) | Requires G1 (reproducible deploy-time source) + factory-level authority work (§4.4) |

Everything in §1–§5 concerns the **Forge-owned factory** path only.

## 1. GitHub App ownership/administration verification

- A Forge-operated GitHub App holds read access to repositories whose
  owners want verifiable launches. On user request the backend:
  1. verifies the requesting GitHub account is an **admin** on repo R
     (`GET /repos/{o}/{r}` → `permissions.admin`) or the org owner;
  2. resolves R's canonical identity (§2);
  3. produces a dated, signed eligibility attestation consumed by §3/§4.
- The App is the only component that can assert repo ownership; Forge never
  derives ownership from scraping.

## 2. Repository identity — canonical ID vs. binding evidence

**Canonical identity:** the GitHub **numeric repository ID**
(`githubRepoId: uint64`). It is globally unique and stable across renames
and owner transfers, which is why it — and nothing derived from names — is
the on-chain identity key.

**Binding evidence (separately recorded, freshness-checked, non-identity):**
`installationId`, `ownerLogin`, `repoFullName`, `defaultBranchHeadSha`
(snapshot), `adminEvidenceRef` (App verification record), `verifiedAt`,
`attestationExpiresAt`.

Rules:
- A binding is `{ githubRepoId → wallet, evidence…, revokedAt }` in the
  `ForgeBindingRegistry`; one active binding per repo ID.
- **Rename** keeps the ID: the binding stays valid, but `repoFullName` goes
  stale; the next launch requires a fresh attestation (§ freshness) that
  re-resolves the name, and a `repository.renamed` webhook updates the
  record. A rename can never mint a *new* identity.
- **Transfer** to another owner: webhook `repository.transferred` → binding
  force-revoked immediately; the new owner must pass a fresh admin check.
  The old wallet's launch authority dies at transfer time, retroactively
  for future launches (already-launched tokens are immutable on chain).
- **Uninstall / loss of admin / archive:** webhooks
  (`github_app_authorization_deleted`, `member_removed`, `archived`) revoke
  or mark stale.
- **Freshness:** every launch consumes an attestation younger than
  `MAX_ATTESTATION_AGE` (proposed: 72h); the backend re-verifies admin
  status before re-issuing.

## 3. Four distinct authorization layers

| Layer | What it proves | What it does NOT prove |
| --- | --- | --- |
| 1. Wallet signature (creator's EIP-712, §4.2) | The wallet consents to this exact launch (params, metadata, economics, salt, nonce) | That the wallet is *entitled* to launch for the repository. **A wallet signature never substitutes for layer 3** |
| 2. GitHub administration evidence | GitHub account A held admin on repository R at time T (App API record) | Anything about the wallet; anything after T |
| 3. Forge eligibility-authority attestation | Forge's verifier attests: "wallet W is the approved launcher for repoId R until T" (App-backend key) | On-chain enforceability by itself |
| 4. On-chain launch authorization | The eligibility authority's signature/registry entry is verified **inside the launch path** | — this is the only layer the chain enforces |

## 4. The Forge-owned factory: bypass prevention

### 4.1 Deployment-time enforcement (no PONS cooperation involved)

The Forge factory is deployed configured-closed, and the deployment is not
complete until an on-chain assertion suite passes:

- `launchEnabled == false` from genesis (constructor/deployment arg);
- `whitelistedLaunchers == { ForgeLaunchGate }` and nothing else;
- `launchForwarder` is the gate itself (or left zero — the gate calls
  `launchToken` directly; no relayer is ever configured);
- post-deploy assertions (script + test): `canLaunch(anyNonGate) == false`,
  `canLaunch(gate) == true`, `launchForwarder ∈ {gate, 0}`, dependencies
  wired per `_requireLaunchDependenciesWired`.

### 4.2 Launch path

`ForgeLaunchGate.launchToken(...)`: verifies the creator's EIP-712
`LaunchAuthorization` (params hash, `repoId`, `economicsDigest` =
`previewLaunchEconomics(...)`, salt, `deadline ≤ 10 min`, per-wallet nonce),
checks the registry binding is active and the attestation fresh, then calls
the factory with the gate as the whitelisted launcher. Relayers may submit
the transaction: every check binds the **creator's** signature and repoId,
never `msg.sender`.

### 4.3 Threat closure table

| Bypass vector | Closure |
| --- | --- |
| Direct factory calls (`launchToken`) by third parties | `launchEnabled=false` + whitelist = {gate} at genesis; deployment assertions |
| Inherited permissionless overloads (`launchToken`, `launchTokenFor`, exemption overload) | All funnel through `_launchToken`, so the same gate/authority check covers every entry point; `launchTokenFor` additionally requires `msg.sender == launchForwarder` (= gate/zero — no relayer trust) |
| Owner/administrator privileges (`setLaunchEnabled(true)`, `setWhitelistedLauncher`, `setLaunchForwarder`) | Pre-M1: governance trust + monitoring (residual, §4.4). Post-M1: structurally closed — see below |
| Whitelist reopening | Same as owner row; every admin change flows through the Forge timelocked multisig and is monitored |
| Forwarders / relayers | No relayer is ever configured; `launchTokenFor`'s forwarder slot is the gate or zero; relayers may submit but never authorize |
| Signer replay | EIP-712 digest binds configId, pairToken, repoId, metadata hash, economics digest, salt, creator, `nonce`, `deadline`, `chainId`, gate address; per-wallet nonce registry; factory CREATE2 salt gives address-level replay separation |
| Factory/chain substitution | EIP-712 domain = (chainId, gate address); the registry and gate are deployed per chain; Forge recognizes only its own published (chain → factory, gate, registry) tuples. A different factory or chain cannot consume a Forge authorization |

### 4.4 The structural gap and the minimum factory modification (future reviewed work — NOT in this PR)

**Preferred invariant:** *no Forge-issued token can be deployed through the
Forge factory without valid authorization from the approved eligibility
authority.*

With stock PONS V2 source, whitelist-only enforcement achieves this
invariant **except** against the factory owner, who can always re-open a
permissionless path. Trusting our own multisig reduces but does not remove
that gap. The minimum factory-level change that makes the invariant
structural:

- **M-ELIG (preferred, ~30-line additive diff):** constructor-injected
  `eligibilityAuthority` address + a require inside `_launchToken` that the
  call carries a valid EIP-712 signature from `eligibilityAuthority` over
  the launch digest (all `TokenParams`, config id, pair token, creator,
  salt, nonce, deadline), with an on-chain nonce registry. Then *no*
  owner action — `setLaunchEnabled(true)`, extra whitelist entries, or a
  new forwarder — can produce a launch without the authority's signature,
  because the check sits inside `_launchToken` below every entry point.
- **M-INTERNAL (alternative):** make `launchToken`/`launchTokenFor`
  `internal` and expose only a gate-shaped external API — stronger, but a
  larger API break.

M-ELIG is a modification to upstream production source: it must go through
full review (with the G1 source-integrity work, not before), fresh audits,
and its own findings register. It is deliberately **not implemented here**.

## 5. ForgeBindingRegistry

```
struct Binding {
  uint64  githubRepoId;      // canonical identity
  address wallet;
  bytes32 evidenceHash;      // installationId ⊕ ownerLogin ⊕ fullName ⊕ headSha ⊕ adminRef
  uint64  boundAt;
  uint64  attestationExpiresAt;
  uint64  revokedAt;
}
```

Signer-gated writes (App-backend key, rotatable, later a small multisig);
webhook-driven revocation (§2). No PONS contract changes required.

## 6. Fee policy authority — three models

The illustrative FINCO intent is **70% builder creator / 20% FINCO treasury
/ 10% FINCO buyback-and-burn allocation**. **That distribution is not
implemented, and is not executable from reviewed source today.**
`FORGE_FEE_POLICY_AUTHORITY_UNPROVEN`.

**What the reviewed PONS V2 source can express at all:** per launch, a
protocol share (`protocolFeeShareBps` ≤ 50% → one `protocolFeeRecipient`),
a creator share (remainder → one creator recipient), a creator tax
(`creatorTaxBps` ≤ 10%, 100% creator), and a buyback slice
(`buybackBurnBps`, carved from the creator bucket → the five-year vesting
vault). There is no third recipient, no burn recipient, and no way to exempt
any configured recipient from governance.

### MODEL A — Original PONS factory (FINCO token issuance track)

- **Who controls the fee policy:** the PONS owner exclusively
  (`PonsV2MemeHook` setters; per-launch snapshots frozen at registration).
- **Where fees are held:** `PonsV2FeeEscrow` (`0xd3AF…Ac9e`) — **source
  unpublished (F-02); custody is unreviewable.** Buyback slices land in
  `PonsV2BuybackVault` (source published, reviewed here).
- **Who can claim:** whichever recipients PONS configured (protocol) and
  the launch's creator recipient. Subject to PONS-owner powers F-03/F-04.
- **Forge's rights:** none beyond any user's. Forge cannot redirect,
  configure, or verify beyond published interfaces.
- **Achievability of 70/20/10 here:** NO — not for Forge-branded launches
  (we cannot set policy), and not even as a description of PONS' own
  economics.

### MODEL B — Forge-owned factory (the GitHub-verified launch venue)

- **Who controls the fee policy:** FINCO governance on the Forge-deployed
  hook/factory, within the ceilings the source enforces.
- **Where fees are held:** the Forge-deployed escrow and buyback vault
  (fresh deployments from reviewed source).
- **Illustrative 70/20/10 mapping (NOT implemented):**
  `protocolFeeShareBps = 2000` → 20% to a FINCO treasury
  `protocolFeeRecipient`; creator leg ≈ 70% to the builder as
  `creatorFeeRecipient`; buyback slice `buybackBurnBps ≈ 1428` of the
  creator bucket ≈ 10% of the total → **`PonsV2BuybackVault` five-year
  vesting — this is LOCKING, NOT BURNING, and the vault's release re-splits
  by `protocolFeeShareBps` (20/80), so the effective vested allocation is
  not a clean 10% to a dedicated burn pot.** True burn exists only via the
  future, disabled `ForgeBuybackBurner` (§7). A dedicated third recipient
  would require a factory/hook modification (future reviewed work, like
  M-ELIG).
- **Missing components:** `PonsV2FeeEscrow` and `PonsV2LaunchAndBuy`
  sources must be rebuilt and reviewed; the M-ELIG authority change and any
  recipient-model change need independent security review before MODEL B
  exists.
- **Status:** `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN` until the Forge factory
  is deployed from fully reproducible, reviewed source.

### MODEL C — Creator-fee delegation (available to FINCO as a user, both tracks)

- A creator voluntarily directs its **own** creator share to a
  Forge-controlled claimant (`creatorFeeRecipient` at launch, or
  `transferCreatorFeeRecipient` later), optionally routing some of it to
  the buyback vest via `setBuybackEnabled` (creator may enable; PONS owner
  may only disable).
- **Who controls it:** the creator (can revoke by re-transferring; subject
  to the F-03 owner-override power on the original factory).
- **NOT equivalent to 70/20/10:** it delegates only the creator leg (≤
  whatever share the creator has), per launch, per creator consent.
  Reporting a creator-delegated stream as "the Forge fee distribution"
  would be misrepresentation.

### Fee-model comparison table

| Question | MODEL A (original PONS) | MODEL B (Forge factory) | MODEL C (creator delegation) |
| --- | --- | --- | --- |
| Fee policy controlled by | PONS owner | FINCO governance (within source ceilings) | Each creator (their leg only) |
| Fees held in | PonsV2FeeEscrow (source missing) + buyback vault | Forge-deployed escrow + vault (from reviewed source) | Same escrow/vault, credited to the chosen claimant |
| Who claims | PONS-configured recipients + creators | Treasury / builder / vest per configured policy | Forge claimant, until the creator re-transfers |
| 70/20/10 achievable | No | Approximately (with the vest re-split caveat; burn needs §7) | No — creator-leg only |
| Missing from published source | Escrow + router (F-02) | Same + M-ELIG/recipient work | Same (as user) |
| Independent review required | n/a (unreviewable) | Full review of factory/hook/escrow/vault changes | n/a (no new contracts) |

## 7. Future revenue-funded buyback and true burn (`FINCO_BURN_ENABLED=false`)

- `ForgeBuybackBurner` (future, disabled at deploy): holds collected quote
  asset, buys the target token on its graduated V4 pool via the Universal
  Router with slippage bounds from an independent price, and — only if
  `FINCO_BURN_ENABLED` is flipped to true by a later governance action —
  calls the token's `burn` (holder-voluntary burn already exists on
  `PonsV2LauncherToken`) on the bought balance.
- Until the flag flips, purchased supply parks in the contract and is
  accounted publicly (`pendingBurnBalance()`).
- **No FINCO token contract address is defined, invented, or implied
  anywhere in this repository.** The FINCO token issuance itself runs on
  the original PONS V2 factory as a separate track.
- **PONS' five-year buyback vesting is not supply destruction:** vested
  tokens return to circulation to recipients. Any document that describes
  PONS buybacks as "burns" is wrong; this design keeps the two strictly
  separate.

## 8. Proof of Build events

```
event ForgeProofOfBuild(
  address indexed token, uint64 indexed githubRepoId,
  bytes32 metadataHash, bytes32 economicsDigest,
  address indexed creator, uint256 boundAt, uint256 launchedAt
);
```

Emitted by the gate on every successful launch; indexers join it with the
factory's `TokenLaunched` event and the App's attestation log to make "this
token belongs to this repository, launched by this wallet, under these
economics" publicly verifiable end to end.

## 9. Sequencing

1. (blocked on F-01/F-02) obtain build-equivalent upstream source.
2. Implement `ForgeBindingRegistry` + gate against the local mock harness
   (can start immediately — factory ABI only).
3. GitHub App + backend attestation service (repo-ID identity, §2
   freshness).
4. Deploy the **Forge-owned factory** configured-closed (§4.1); deployment
   assertions green.
5. Factory modification M-ELIG: design → review → deploy → then the
   bypass-prevention invariant is structural rather than trust-based.
6. `ForgeBuybackBurner` last, flag off.
