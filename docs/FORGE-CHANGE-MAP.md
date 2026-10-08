# Forge Change Map — design only (no implementation in this PR)

Minimal design for the Forge-specific additions defined by the FINCO Forge
Implementation Blueprint. **Nothing here is implemented in this PR**; the
FINCO token itself will initially launch externally through original PONS
V2, no second FINCO token is issued, and `FINCO_BURN_ENABLED=false`.

## 0. Constraints carried forward

- The PONS V2 factory's `launchToken` is permissionless subject to
  `canLaunch(msg.sender)`; economics are frozen per launch and the
  creator-fee recipient and salt are caller-supplied. Any ownership gate
  therefore has to live **in front of the factory call**, with the gate
  itself holding the whitelist slot or acting as the factory owner's
  delegated launcher.
- Per `docs/SECURITY-REVIEW.md` F-01/F-02: implementation is blocked until
  upstream publishes build-equivalent source. This document fixes the
  design so implementation can start the day the blocker clears.

## 1. GitHub App ownership/administration verification

- A Forge-operated GitHub App holds read access to repositories whose
  owners want verifiable launches. On user request the backend:
  1. verifies the requesting GitHub account is an **admin** on repo R
     (`GET /repos/{o}/{r}` → `permissions.admin`) or the org owner;
  2. computes `repoId = keccak256(abi.encode(installationId, R.fullName, R.id))`;
  3. emits a signed attestation (off-chain) consumed by the launch signer.
- The App is the only component that can assert repo ownership; Forge
  never derives ownership from scraping. Revocation = App uninstalled or
  admin rights lost → the registry entry is marked revoked (§6).

## 2. Wallet-to-repository binding (`ForgeBindingRegistry`, new contract)

```
struct Binding { bytes32 repoId; address wallet; uint64 boundAt; uint64 revokedAt; }
mapping(bytes32 repoId => Binding) public bindings;      // one active binding per repo
mapping(address wallet => bytes32[]) public byWallet;
```

- `bind(repoId, wallet)`: only the Forge binding signer (App-backend key,
  rotatable, later a small multisig) may write. One active binding per
  repo; re-binding after revocation allowed with a fresh signature.
- Deployment shape: standalone registry contract referenced by the launch
  gate. No PONS contract changes required.

## 3. EIP-712 launch authorization

```
LaunchAuthorization(
  uint256 launchConfigId,
  address pairToken,
  bytes32 repoId,
  bytes32 tokenMetadataHash,   // keccak256(name, symbol, logo, description, socials)
  bytes32 economicsDigest,     // = factory.previewLaunchEconomics(...) at signing time
  bytes32 salt,
  uint64  deadline,
  uint64  nonce
)
DOMAIN = EIP712("FINCO Forge Launch", "1", chainid(4663), gateAddress)
```

- The creator signs the authorization in the browser after the App has
  verified ownership; the gate verifies ECDSA against the bound wallet.
- `economicsDigest` reuses the factory's own anti-repeg pin so owner
  re-pegs can't land under a signed launch.

## 4. Direct factory bypass prevention

- `ForgeLaunchGate.launchToken(...)` is the **only** supported path: the
  gate (a) verifies the EIP-712 authorization, (b) checks
  `bindings[repoId]` is active for `msg.sender`, (c) checks
  `factory.canLaunch(address(gate))`, (d) forwards with the gate as the
  whitelisted launcher and the creator as `originalDeployer`-equivalent
  via `launchTokenFor`'s forwarder slot (the factory's
  `setLaunchForwarder` is owner-set — requires a one-time Pons-owner
  action, or alternatively the gate holds a whitelisted-launcher slot and
  calls `launchToken` directly, attributing the creator in our own events).
- Residual risk (documented, accepted): while public launches are open
  (`canLaunch` currently returns true — F-11), anyone can bypass the gate
  by calling the factory directly. Full enforcement therefore requires
  the Pons owner to close the public gate (`setLaunchEnabled(false)`) and
  whitelist only the gate. This is a coordination prerequisite, not a
  code change on our side.

## 5. Nonce and replay protection

- Per-wallet incremental nonce in the gate (`usedNonces[wallet][nonce]`),
  plus `deadline` (max 10 minutes) in the EIP-712 payload.
- `salt` remains the factory-level replay separator: a duplicate launch
  on identical terms collides at CREATE2 and reverts — note the current
  upstream deployer lacks CREATE2 (F-01); the design **requires** the
  deployed CREATE2 behavior to be restored before the gate ships.

## 6. Token metadata and fee-policy binding

- `tokenMetadataHash` binds the signed authorization to the exact
  metadata the token will carry; the gate re-hashes the supplied params
  and reverts on mismatch.
- `FeePolicySnapshot` binding: the gate stores the snapshot returned by
  `memeHook.currentFeePolicy()` at authorization time and re-checks it at
  execution, so a policy change invalidates rather than silently reprices
  the launch (defense in depth on top of `expectedEconomics`).

## 7. Repository ownership revocation

- GitHub webhook (`github_app_authorization_deleted`, `member_added/removed`)
  → backend flags the binding; `revoke(repoId)` on the registry (signer-
  gated) sets `revokedAt`, after which new launches are refused. Existing
  launches are immutable on-chain and unaffected (by design).

## 8. Proof of Build events

```
event ForgeProofOfBuild(
  address indexed token, bytes32 indexed repoId,
  bytes32 metadataHash, bytes32 economicsDigest,
  address indexed creator, uint256 boundAt, uint256 launchedAt
);
```

- Emitted by the gate on every successful launch; indexers join it with
  the factory's `TokenLaunched` event (token/curve addresses) and the
  GitHub App's attestation log to make "this token belongs to this
  repository, launched by this wallet, under these economics" publicly
  verifiable end to end.

## 9. Future FINCO fee collection

- Design: a `ForgeFeeCollector` set as **protocol fee recipient** is NOT
  available to us (that is the Pons owner's `protocolFeeRecipient`).
  Achievable alternatives, in order of preference:
  1. Creator-tax route: FINCO-launched tokens set `creatorFeeRecipient`
     to a Forge-owned claimant address, and the escrow claim is swept by
     our collector on a schedule. No PONS changes; works today for
     launches where the creator delegates that address to Forge by
     signature.
  2. Buyback-enabled launches: the buyback leg already locks supply in
     `PonsV2BuybackVault` with a Forge-chosen creator recipient — value
     accrues as vested supply rather than fees.
- No change to PONS fee routing is designed or assumed.

## 10. Future revenue-funded buyback and true burn (`FINCO_BURN_ENABLED=false`)

- `ForgeBuybackBurner` (future, disabled at deploy): holds collected
  quote asset, buys FINCO on the graduated V4 pool via the Universal
  Router with slippage bounds from an independent price, and — only if
  `FINCO_BURN_ENABLED` is flipped to true by a later governance action —
  calls `PonsV2LauncherToken.burn` (holder-voluntary burn is already in
  the token) on the bought balance.
- Until the flag flips, purchased supply parks in the contract and is
  accounted publicly (`pendingBurnBalance()`), preserving the "buyback
  not burn" semantics of the initial phase and the workflow's requirement
  that no burn executor ships now.

## 11. Sequencing

1. (blocked on F-01/F-02) obtain build-equivalent upstream source.
2. Implement `ForgeBindingRegistry` + gate against the **testable** local
   harness (factory excluded from compile today — the gate interfaces
   with the factory ABI only, so it can be built and tested against mocks
   already in `test/mocks/`).
3. GitHub App + backend attestation service.
4. Coordination: Pons owner closes public launches; gate whitelisted.
5. `ForgeBuybackBurner` last, flag off.
