# Roadmap — verified-blocker-driven follow-ons

Ordered by dependency, not by preference. Items G1–G3 gate all financial
contract development (Workflow-01 acceptance condition).

## G1. Source integrity (blocks everything) — from F-01/F-02

- [ ] Obtain deploy-time source for: `PonsV2BondingCurve` (with snipe-tax),
      `PonsV2LaunchDeployer` (CREATE2), `PonsV2FeeEscrow`,
      `PonsV2LaunchAndBuy`, and the V2 deployment metadata (solc/settings).
- [ ] Byte-verify published source against Robinhood Chain deployed code
      (Blockscout/Etherscan verification, then `forge verify-contract`
      matching or bytecode equality where constructions are deterministic).
- [ ] Flip the CI full-build canary into a hard gate; extend the test
      suite to the factory (launch gating, economics pin, CREATE2
      namespacing, two-phase graduation, owner paths, snipe tax).

## G2. Assurance (blocks production launch usage)

- [ ] Track the three announced audits (SB Security, Dingbats, Pashov) to
      publication; verify each report's reviewed commit against G1's
      resolved HEAD; triage every High/Medium into this register.
- [ ] Push for Hackerbane's two High findings (owner fee-recipient
      override, reserve rescue) to be closed or contractually bounded.
- [ ] Independent review of `PonsV2FeeEscrow` the moment its source lands
      (it custodies all protocol/creator revenue).

## G3. Trust architecture (blocks FINCO-branded launches)

- [ ] Owner key posture on the deployed factory/hook: confirm multisig,
      publish timelock usage (creator-recipient override, rescue paths).
- [ ] Sweep-operator key isolation + independent-price floor computation
      for fee conversions (F-05).
- [ ] Replace `v4-hooks-public/BaseHook.sol` with a hash-verified public
      copy; prune easter-egg files from vendored trees (F-14).

## N1. Forge gate (design in `docs/FORGE-CHANGE-MAP.md`)

- [ ] `ForgeBindingRegistry` + EIP-712 launch gate against the mock
      factory harness (can start immediately — factory ABI only).
- [ ] GitHub App attestation service (repo admin verification, webhook
      revocation).
- [ ] Coordination item: Pons owner closes public launches (`canLaunch`
      currently open) and whitelists the gate — otherwise the gate is
      bypassable.

## N2. Forge economics add-ons

- [ ] Fee-collection route decision (creator-tax claimant vs buyback
      vesting) with counsel review of BUSL exposure (F-09).
- [ ] `ForgeBuybackBurner` — build with `FINCO_BURN_ENABLED=false`;
      flip only by later, explicit governance action.

## Maintenance

- [ ] Keep `upstream` remote fetched; re-run the vendored-dep integrity
      job on every upstream sync (CI already does).
- [ ] Re-validate chain 4663 addresses after any Uniswap deployment
      change on the chain (CI smoke job reads the factory wiring).
