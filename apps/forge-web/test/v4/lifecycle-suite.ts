/**
 * The genuine-V4 lifecycle acceptance suite, parameterised by mode so the
 * local-genuine project and the CI fork project run the SAME assertions.
 */
import { FORK_DEFERRED_STEPS } from "./fork-deferred";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2FeeEscrowAbi, ponsV2LaunchFactoryAbi, ponsV2LaunchLockerAbi, ponsV2MemeHookAbi } from "@/shared/abis.generated";
import type { SandboxDeployment } from "../../scripts/sandbox-lib";
import { deployForgeOnGenuine, startGenuineChain, type GenuineChain, type GenuineMode } from "../../scripts/w05/genuine-v4";
import { hookMaskOk, create2Address } from "../../scripts/w05/hook-mine-lib";
import { KEYS, Lifecycle, NATIVE } from "./lifecycle";

const READ_POOL_MANAGER = [{ type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

export function defineGenuineLifecycleSuite(mode: GenuineMode) {
  let chain: GenuineChain;
  let d: SandboxDeployment;
  let L: Lifecycle;
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    chain = await startGenuineChain(mode);
    d = await deployForgeOnGenuine(chain);
    L = new Lifecycle(chain, d);
    await L.fund();
    await L.deployHelpers();
  });
  afterAll(async () => {
    if (evidence.steps) console.log(`W05_GENUINE_V4_EVIDENCE ${mode} ${JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    await chain?.stop();
  });

  // MEASURED (PR CI): the Anvil fork of chain 4663 emulates ArbOS (0x64 is a precompile that cannot be
  // replaced; L1/L2 gas accounting differs), so steps 7-9 (splitter attestation -> pulls -> claims) cannot be
  // reproduced on a LOCAL fork. They run in full on the fresh-Anvil genuine-V4 suite (mode "local"); the
  // real-chain ArbSys property is asserted read-only by test/v4-fork/arbos-block-semantics.test.ts and the
  // splitter's ArbSys branch by forge tests (test_H2_*). This is a documented gap, NOT a pass.
  const deferred = (n: number) => mode === "fork" && (FORK_DEFERRED_STEPS as readonly number[]).includes(n);
  const itStep = (n: number) => (deferred(n) ? it.skip : it);
  describe(`W05 genuine Uniswap V4 lifecycle (${mode})`, () => {
    const steps: string[] = [];
    evidence.steps = steps;

    it("0. the Forge stack is wired to the GENUINE V4 contracts (no mini mocks) and the hook carries mask 0x2044", async () => {
      expect(d.v4Source).toBe("GENUINE_UNISWAP_V4");
      expect(getAddress(d.poolManager)).toBe(getAddress(chain.v4.poolManager));
      expect(getAddress(d.positionManager)).toBe(getAddress(chain.v4.positionManager));
      expect(getAddress(d.permit2)).toBe(getAddress(chain.v4.permit2));
      for (const p of chain.v4.provenance) expect(p.runtimeCheck.equalAfterMasking, `${p.contract} runtime == genuine artifact`).toBe(true);
      expect(hookMaskOk(d.memeHook)).toBe(true);
      expect(create2Address(d.hookCreate2!.deployer, d.hookCreate2!.salt, d.hookCreate2!.initCodeHash)).toBe(getAddress(d.memeHook));
      expect(getAddress(await L.read<Address>(d.memeHook, READ_POOL_MANAGER, "poolManager"))).toBe(getAddress(chain.v4.poolManager));
      expect(getAddress(await L.read<Address>(d.factory, ponsV2LaunchFactoryAbi, "poolManager"))).toBe(getAddress(chain.v4.poolManager));
      expect(getAddress(await L.read<Address>(d.memeHook, ponsV2MemeHookAbi, "protocolFeeRecipient"))).toBe(getAddress(d.revenueSplitter));
      evidence.hook = { address: d.memeHook, ...d.hookCreate2 };
      evidence.v4 = { poolManager: chain.v4.poolManager, positionManager: chain.v4.positionManager, permit2: chain.v4.permit2 };
      steps.push("wiring");
    });

    it("1. repo binding (authority-signed) and an authorized launch through ForgeLaunchAuthorizer", async () => {
      await L.bind();
      const r = await L.launch(100);
      expect(r.status).toBe("success");
      expect(await L.tokenBalance(L.curve)).toBe(BigInt(d.launchConfig.supply));
      steps.push("bind+launch");
    });

    it("2. curve buys accrue fees; the creator sweeps the curve leg into the canonical escrow", async () => {
      await L.buyOnCurve("5");
      const fee = await L.read<bigint>(L.curve, ponsV2BondingCurveAbi, "quoteFeeBalance");
      expect(fee).toBe(parseEther("0.05"));
      const before = await L.escrowBalance(d.revenueSplitter);
      await L.send(KEYS.creator, L.curve, ponsV2BondingCurveAbi, "sweepFees", [0n]);
      expect((await L.escrowBalance(d.revenueSplitter)) - before).toBe((fee * 3_000n) / 10_000n);
      steps.push("curve-buys+sweep");
    });

    it("3. graduation seeds a full-range position through the GENUINE PositionManager + Permit2; the NFT is locked", async () => {
      await L.buyOnCurve("100"); // crosses the 30 ETH threshold
      const r = await L.graduateAndSeed();
      expect(r.status).toBe("success");
      expect(await L.phase()).toBe(2); // PoolCreated
      expect(await L.read<boolean>(d.locker, ponsV2LaunchLockerAbi, "isLocked", [L.token])).toBe(true);
      const s = await L.poolState();
      expect(s.positionOwner).toBe(getAddress(d.locker));
      expect(s.sqrtPriceX96).toBeGreaterThan(0n);
      expect(s.liquidity).toBeGreaterThan(0n);
      expect(s.positionLiquidity).toBe(s.liquidity);
      // The genuine PoolManager actually holds the seeded reserves.
      expect(await L.pub.getBalance({ address: d.poolManager })).toBeGreaterThan(0n);
      expect(await L.tokenBalance(d.poolManager)).toBeGreaterThan(0n);
      // The executor never keeps a balance between transactions.
      expect(await L.pub.getBalance({ address: d.graduationExecutor })).toBe(0n);
      expect(await L.tokenBalance(d.graduationExecutor)).toBe(0n);
      evidence.pool = { poolId: L.poolId, positionId: L.positionId, ...s };
      steps.push("graduation+seed");
    });

    it("4. a real sell through the genuine PoolManager (PoolSwapTest) produces a quote-denominated hook fee", async () => {
      const held = await L.tokenBalance(L.c(KEYS.buyer).account.address);
      const ethBefore = await L.pub.getBalance({ address: L.c(KEYS.buyer).account.address });
      const r = await L.swap(KEYS.buyer, false, held / 4n);
      expect(r.status).toBe("success");
      const p = await L.pending(NATIVE);
      expect(p.fee).toBeGreaterThan(0n);
      expect(p.tax).toBeGreaterThan(0n);
      // the seller received ETH net of gas
      expect(await L.pub.getBalance({ address: L.c(KEYS.buyer).account.address })).toBeGreaterThan(ethBefore - parseEther("0.01"));
      evidence.sellFee = p;
      steps.push("swap-sell");
    });

    it("5. the creator sweeps the quote fees: protocol 30% to the splitter key, creator 70% + tax to the creator key", async () => {
      const p = await L.pending(NATIVE);
      const spl0 = await L.escrowBalance(d.revenueSplitter);
      const cr0 = await L.escrowBalance(L.creator);
      await L.send(KEYS.creator, d.memeHook, ponsV2MemeHookAbi, "sweepPoolFees", [L.poolId, 0n, 0n]);
      const protocol = (p.fee * 3_000n) / 10_000n;
      expect((await L.escrowBalance(d.revenueSplitter)) - spl0).toBe(protocol);
      expect((await L.escrowBalance(L.creator)) - cr0).toBe(p.fee - protocol + p.tax);
      expect((await L.pending(NATIVE)).fee).toBe(0n);
      steps.push("sweep-quote-fees");
    });

    it("6. a buy produces a memecoin fee; only the fee-sweep operator may convert it via the hook's own genuine-V4 swap", async () => {
      await L.swap(KEYS.buyer, true, parseEther("1"));
      const p = await L.pending(L.token);
      expect(p.fee).toBeGreaterThan(0n);
      // The creator cannot trigger an internal conversion (price-sensitive).
      await expect(L.send(KEYS.creator, d.memeHook, ponsV2MemeHookAbi, "sweepPoolFees", [L.poolId, 1n, 0n])).rejects.toThrow();
      await L.send(KEYS.governance, d.memeHook, ponsV2MemeHookAbi, "setFeeSweepOperator", [L.c(KEYS.operator).account.address]);
      const spl0 = await L.escrowBalance(d.revenueSplitter);
      await L.send(KEYS.operator, d.memeHook, ponsV2MemeHookAbi, "sweepPoolFees", [L.poolId, 1n, 0n]);
      expect((await L.pending(L.token)).fee).toBe(0n);
      expect(await L.escrowBalance(d.revenueSplitter)).toBeGreaterThan(spl0);
      steps.push("swap-buy+operator-conversion");
    });

    itStep(7)("7. attested ceiling → splitter pull allocates 2:1 (treasury:reserve); third parties cannot exceed the ceiling", async () => {
      const head = await L.pub.getBlockNumber();
      const eligible = await L.eligibleNativeCredits(BigInt(d.deployBlock), head);
      expect(eligible).toBe(await L.escrowBalance(d.revenueSplitter));
      // A third-party escrow credit to the splitter key is NOT eligible.
      await L.send(KEYS.stranger, d.feeEscrow, ponsV2FeeEscrowAbi, "credit", [d.revenueSplitter], parseEther("0.3"));
      // No ceiling yet → pulls fail closed.
      await expect(L.send(KEYS.stranger, d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n])).rejects.toThrow();
      await L.attest(eligible);
      const r0 = await L.reconcile();
      await L.send(KEYS.stranger, d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]);
      const l = await L.ledger();
      expect(l.escrowClaimed).toBe(eligible);
      expect(l.revenueReceived).toBe(eligible);
      expect(l.reserveAllocated).toBe(eligible / 3n);
      expect(l.treasuryAllocated).toBe(eligible - eligible / 3n);
      // the third-party 0.3 ETH stays in the escrow
      expect(await L.escrowBalance(d.revenueSplitter)).toBe(parseEther("0.3"));
      const r1 = await L.reconcile();
      expect(r1.deficit).toBe(0n);
      expect(r1.balance - r0.balance).toBe(eligible);
      evidence.splitter = { eligible, ledger: l, reconcile: r1 };
      steps.push("attest+pull");
    });

    itStep(8)("8. the treasury recipient claims its liability; the reserve has no exit", async () => {
      const t = L.c(KEYS.treasury);
      const liability = await L.read<bigint>(d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "treasuryLiability", [NATIVE]);
      expect(liability).toBeGreaterThan(0n);
      await expect(L.send(KEYS.stranger, d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "claimTreasury", [NATIVE, 0n])).rejects.toThrow();
      const b0 = await L.pub.getBalance({ address: t.account.address });
      const r = await L.send(KEYS.treasury, d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "claimTreasury", [NATIVE, 0n]);
      const gas = r.gasUsed * r.effectiveGasPrice;
      expect((await L.pub.getBalance({ address: t.account.address })) - b0 + gas).toBe(liability);
      const l = await L.ledger();
      expect(l.treasuryPaid).toBe(l.treasuryAllocated);
      expect(await L.read<bigint>(d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "reserveLiability", [NATIVE])).toBe(l.reserveAllocated);
      const rc = await L.reconcile();
      expect(rc.deficit).toBe(0n);
      expect(rc.balance).toBeGreaterThanOrEqual(rc.accounted);
      steps.push("treasury-claim");
    });

    itStep(9)("9. the creator claims everything credited to them in the canonical escrow", async () => {
      const owed = await L.escrowBalance(L.creator);
      expect(owed).toBeGreaterThan(0n);
      const b0 = await L.pub.getBalance({ address: L.creator });
      const r = await L.send(KEYS.creator, d.feeEscrow, ponsV2FeeEscrowAbi, "claim", []);
      const gas = r.gasUsed * r.effectiveGasPrice;
      expect((await L.pub.getBalance({ address: L.creator })) - b0 + gas).toBe(owed);
      expect(await L.escrowBalance(L.creator)).toBe(0n);
      evidence.creatorClaimed = owed;
      steps.push("creator-claim");
    });

    it("10. supply conservation across pool, holders, locker, hook and escrow", async () => {
      const supply = BigInt(d.launchConfig.supply);
      const holders = [d.poolManager, L.c(KEYS.buyer).account.address, d.locker, d.memeHook, d.feeEscrow, d.buybackVault, L.curve, d.graduationExecutor, L.swapRouter, d.factory];
      let sum = 0n;
      for (const h of holders) sum += await L.tokenBalance(h);
      expect(sum).toBe(supply);
      steps.push("supply-conservation");
    });
  });
}
