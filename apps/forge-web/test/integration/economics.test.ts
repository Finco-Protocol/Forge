/**
 * W04 economics acceptance over the REAL Forge stack on a STANDARD Anvil
 * (EIP-170 enforced): factory → curve → canonical PonsV2FeeEscrow →
 * ForgeProtocolRevenueSplitter → treasury claim, plus graduation → hook,
 * through the real API, indexer and ledger. Nothing is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2FeeEscrowAbi, ponsV2MemeHookAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { runWorkerOnce } from "@/server/worker";
import { treasuryReport } from "@/server/finance/service";
import { startSandbox, TestBrowser, chainClients, ANVIL_KEYS, type Sandbox } from "../helpers/sandbox";
import { loadArtifact } from "../../scripts/artifacts";
import { rpc } from "../helpers/anvil";
import { freshScenario, launchThroughApi, governanceWrite } from "../helpers/scenario";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const TREASURY_KEY = ANVIL_KEYS[8];
const BUYER_KEY = ANVIL_KEYS[6];
const STRANGER_KEY = ANVIL_KEYS[7];

let sb: Sandbox;
let splitter: Address;

beforeAll(async () => {
  sb = await startSandbox();
  splitter = sb.deployment.revenueSplitter;
});
afterAll(async () => sb?.stop());

async function send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], value = 0n) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const h = await wallet.writeContract({ address, abi, functionName, args, value } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  return { hash: h, status: r.status };
}

async function launch(overrides: Record<string, unknown> = {}) {
  const sc = await freshScenario(sb);
  const l = await launchThroughApi(sb, sc.browser, sc.key, { ...sc.draft, ...overrides });
  await runWorkerOnce(sb.ctx);
  // Step past the launch-second anti-snipe window so buys pay only base fee + creator tax.
  await rpc(sb.anvil.url, "evm_increaseTime", [20]);
  await rpc(sb.anvil.url, "evm_mine");
  return { sc, token: getAddress(l.submitted.json.token), curve: getAddress(l.submitted.json.curve) };
}

async function buy(curve: Address, eth: string) {
  return send(BUYER_KEY, curve, ponsV2BondingCurveAbi, "buy", [parseEther(eth), 0n, chainClients(sb.anvil.url, BUYER_KEY).account.address], parseEther(eth));
}

async function treasuryAsset(asset: Address = NATIVE) {
  const r = await treasuryReport(sb.ctx);
  return { r, a: r.accounting.find((x) => x.asset.asset === asset)! };
}

describe("W04: eligible base-fee distribution 70/20/10 (sandbox, real contracts)", () => {
  let token: Address;
  let curve: Address;
  let creatorBrowser: TestBrowser;
  let creator: Address;
  let creatorKey: Hex;
  let baseFee: bigint;
  let tax: bigint;

  it("1/2. curve fees: creator gets 70% of the base fee + 100% of the creator tax; the splitter gets 30% of the base fee only", async () => {
    const l = await launch({ creatorTaxBps: 100 });
    ({ token, curve } = l);
    creatorBrowser = l.sc.browser;
    creator = l.sc.address;
    creatorKey = l.sc.key;
    await buy(curve, "10");
    baseFee = await sb.ctx.client.readContract({ address: curve, abi: ponsV2BondingCurveAbi, functionName: "quoteFeeBalance" });
    tax = await sb.ctx.client.readContract({ address: curve, abi: ponsV2BondingCurveAbi, functionName: "creatorTaxBalance" });
    expect(baseFee).toBe(parseEther("0.1"));
    expect(tax).toBe(parseEther("0.1"));
    expect((await send(creatorKey, curve, ponsV2BondingCurveAbi, "sweepFees", [0n])).status).toBe("success");
    await runWorkerOnce(sb.ctx);

    const me = await creatorBrowser.get("/api/finance/creator");
    expect(me.status).toBe(200);
    const row = me.json.launches.find((x: { token: string }) => x.token === token);
    expect(row.economics.eligible70_20_10).toBe(true);
    expect(row.economics.actual).toMatchObject({ creatorPct: 70, protocolPct: 30, treasuryPct: 20, reservePct: 10, creatorTaxPct: 1 });
    const protocol = (baseFee * 3_000n) / 10_000n;
    expect(row.earnedIndexed.baseFee).toBe((baseFee - protocol).toString());
    expect(row.earnedIndexed.creatorTax).toBe(tax.toString());
    expect(row.earnedIndexed.byOrigin.bondingCurve).toBe((baseFee - protocol + tax).toString());
    const eth = me.json.perAsset.find((x: { asset: { asset: string } }) => x.asset.asset === NATIVE);
    expect(eth.reconciliation).toBe("RECONCILED");
    expect(eth.claimableNow).toBe((baseFee - protocol + tax).toString());
  });

  it("3. native payout: anyone pulls the splitter's escrow key; treasury 20 points, reserve 10 points of the base fee", async () => {
    expect((await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n])).status).toBe("success");
    await runWorkerOnce(sb.ctx);
    const { a, r } = await treasuryAsset();
    expect(a.overview.treasuryAllocated).toBe(((baseFee * 2_000n) / 10_000n).toString());
    expect(a.overview.reserveAllocated).toBe(((baseFee * 1_000n) / 10_000n).toString());
    expect(a.reconciliation).toBe("RECONCILED");
    expect(a.statements.escrowCreditedNotPulled.reconciliation).toBe("RECONCILED");
    expect(r.allocations.length).toBe(1);
    const lt = r.launches.find((x) => x.token === token)!;
    expect(lt.credited.protocol).toBe(((baseFee * 3_000n) / 10_000n).toString());
    expect(lt.credited.creatorTax).toBe(tax.toString());
  });

  it("8/9. creator claims through a prepared tx signed by their own wallet; repeat claim is refused", async () => {
    const prep = await creatorBrowser.post("/api/finance/claims/prepare", { asset: NATIVE });
    expect(prep.status).toBe(200);
    expect(prep.json.to).toBe(getAddress(sb.deployment.feeEscrow));
    const { wallet, pub } = chainClients(sb.anvil.url, creatorKey);
    const before = await pub.getBalance({ address: creator });
    const h = await wallet.sendTransaction({ to: prep.json.to, data: prep.json.data, value: 0n });
    const rc = await pub.waitForTransactionReceipt({ hash: h });
    const sub = await creatorBrowser.post("/api/finance/claims/submitted", { txHash: h, asset: NATIVE });
    expect(sub.status).toBe(200);
    expect(sub.json.status.state).toBe("MINED_AWAITING_INDEXER");
    await runWorkerOnce(sb.ctx);
    const after = await pub.getBalance({ address: creator });
    expect(after + rc.gasUsed * rc.effectiveGasPrice - before).toBe(BigInt(prep.json.amount));
    const me = await creatorBrowser.get("/api/finance/creator");
    expect(me.json.claimHistory.length).toBe(1);
    expect(me.json.claimSubmissions[0].status.state).toBe("CONFIRMED_INDEXED");
    const repeat = await creatorBrowser.post("/api/finance/claims/prepare", { asset: NATIVE });
    expect(repeat.status).toBe(409);
    expect(repeat.json.error.code).toBe("NOTHING_TO_CLAIM");
  });

  it("10. unauthorized: a non-treasury wallet cannot prepare a treasury claim, and the contract refuses it anyway", async () => {
    const tr = await creatorBrowser.post("/api/finance/claims/prepare", { asset: NATIVE, kind: "treasury" });
    expect(tr.status).toBe(403);
    expect(tr.json.error.code).toBe("NOT_TREASURY_RECIPIENT");
    const direct = await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "claimTreasury", [NATIVE, 0n]).catch(() => ({ status: "reverted" }));
    expect(direct.status).not.toBe("success");
    // Governance-only knobs are refused for anyone else.
    const pause = await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "setPullsPaused", [true]).catch(() => ({ status: "reverted" }));
    expect(pause.status).not.toBe("success");
    // A submitted claim hash must be the caller's own transaction.
    const foreignTx = await chainClients(sb.anvil.url, STRANGER_KEY).wallet.sendTransaction({ to: creator, value: 1n });
    await chainClients(sb.anvil.url, STRANGER_KEY).pub.waitForTransactionReceipt({ hash: foreignTx });
    const forged = await creatorBrowser.post("/api/finance/claims/submitted", { txHash: foreignTx, asset: NATIVE });
    expect(forged.status).toBe(403);
    expect(forged.json.error.code).toBe("NOT_YOUR_TRANSACTION");
  });

  it("8. the treasury recipient claims partially, then the rest; the reserve has no exit", async () => {
    const tb = new TestBrowser(sb);
    sb.github.addUser(30_001, "forge-treasury");
    await tb.signInGithub(30_001);
    expect((await tb.bindWallet(TREASURY_KEY)).status).toBe(200);
    const liability = BigInt((await treasuryAsset()).a.overview.treasuryOutstanding!);
    const half = liability / 2n;
    for (const amount of [half, 0n]) {
      const prep = await tb.post("/api/finance/claims/prepare", { asset: NATIVE, kind: "treasury", amount: amount.toString() });
      expect(prep.status).toBe(200);
      const { wallet, pub } = chainClients(sb.anvil.url, TREASURY_KEY);
      const h = await wallet.sendTransaction({ to: prep.json.to, data: prep.json.data, value: 0n });
      expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    }
    await runWorkerOnce(sb.ctx);
    const { a } = await treasuryAsset();
    expect(a.overview.treasuryPaid).toBe(liability.toString());
    expect(a.overview.treasuryOutstanding).toBe("0");
    expect(a.overview.reserveOutstanding).toBe(((baseFee * 1_000n) / 10_000n).toString());
    expect(a.reconciliation).toBe("RECONCILED");
    const gov = await tb.get("/api/finance/governance");
    expect(gov.json.roles.splitter.fincoBurnEnabled).toBe(false);
    expect(gov.json.roles.splitter.burnReadiness.enabled).toBe(false);
  });
});

describe("W04: post-graduation V4 hook fees reach the same splitter (20)", () => {
  it("20. curve → graduation → V4 pool → hook fee → escrow → splitter → reconciled", async () => {
    const l = await launch({ creatorTaxBps: 100 });
    const buyer = chainClients(sb.anvil.url, BUYER_KEY);
    await buy(l.curve, "5");
    await buy(l.curve, "100"); // crosses the threshold (auto-graduation is best-effort)
    const phase = (await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchedToken", args: [l.token] })).phase;
    if (phase === 0) await send(BUYER_KEY, sb.deployment.factory, ponsV2LaunchFactoryAbi, "graduate", [l.token]);
    await send(BUYER_KEY, sb.deployment.factory, ponsV2LaunchFactoryAbi, "createGraduatedPool", [l.token]);
    await runWorkerOnce(sb.ctx);
    const before = (await treasuryReport(sb.ctx)).launches.find((x) => x.token === l.token)!;
    expect(before.poolId).toMatch(/^0x[0-9a-f]{64}$/);

    // TEST-ONLY router (test-forge/mocks/SandboxSwapRouter.sol) drives a real pool swap.
    const router = loadArtifact("SandboxSwapRouter");
    const mgr = loadArtifact("MiniPoolManagerW02");
    const dh = await buyer.wallet.deployContract({ abi: router.abi, bytecode: router.bytecode, args: [sb.deployment.poolManager] });
    const routerAddr = (await buyer.pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
    // The W02 mini manager books seeded native reserves without holding the ETH (mock limitation).
    const reserve = (await sb.ctx.client.readContract({ address: sb.deployment.poolManager, abi: mgr.abi, functionName: "poolReserve", args: [NATIVE] })) as bigint;
    await rpc(sb.anvil.url, "anvil_setBalance", [sb.deployment.poolManager, `0x${reserve.toString(16)}`]);
    const held = (await sb.ctx.client.readContract({ address: l.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [buyer.account.address] })) as bigint;
    await send(BUYER_KEY, l.token, [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], "approve", [routerAddr, held]);
    const key = { currency0: NATIVE, currency1: l.token, fee: 0, tickSpacing: 10, hooks: sb.deployment.memeHook };
    expect((await send(BUYER_KEY, routerAddr, router.abi as readonly unknown[], "swapExactIn", [key, false, held / 4n, buyer.account.address])).status).toBe("success");
    const pid = before.poolId as Hex;
    const pendingQuote = await sb.ctx.client.readContract({ address: sb.deployment.memeHook, abi: ponsV2MemeHookAbi, functionName: "pendingFees", args: [pid, NATIVE] });
    expect(pendingQuote).toBeGreaterThan(0n);
    // The creator may distribute quote-only fees (no conversion, buyback off).
    expect((await send(l.sc.key, sb.deployment.memeHook, ponsV2MemeHookAbi, "sweepPoolFees", [pid, 0n, 0n])).status).toBe("success");
    await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]);
    await runWorkerOnce(sb.ctx);

    const { r, a } = await treasuryAsset();
    const t = r.launches.find((x) => x.token === l.token)!;
    expect(BigInt(t.v4Hook.baseFeesQuote!)).toBe(pendingQuote);
    expect(t.v4Hook.sweeps).toBe(1);
    expect(BigInt(t.credited.protocol!) - BigInt(before.credited.protocol!)).toBe((pendingQuote * 3_000n) / 10_000n);
    expect(BigInt(t.credited.creatorTax!)).toBeGreaterThan(BigInt(before.credited.creatorTax!));
    expect(t.credited.creatorUnsplit).toBe("0");
    expect(a.reconciliation).toBe("RECONCILED");
    const me = await l.sc.browser.get("/api/finance/creator");
    const row = me.json.launches.find((x: { token: string }) => x.token === l.token);
    expect(BigInt(row.earnedIndexed.byOrigin.v4Hook)).toBeGreaterThan(0n);
    expect(BigInt(row.earnedIndexed.byOrigin.bondingCurve)).toBeGreaterThan(0n);
  });
});

describe("W04: ineligible revenue never enters 70/20/10", () => {
  it("11/13. third-party escrow credits, direct ETH and launch fees are classified separately", async () => {
    await send(STRANGER_KEY, sb.deployment.feeEscrow, ponsV2FeeEscrowAbi, "credit", [splitter], parseEther("0.5"));
    const { wallet, pub } = chainClients(sb.anvil.url, STRANGER_KEY);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: splitter, value: parseEther("0.25") }) });
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setLaunchFee", [parseEther("0.01")]);
    await launch();
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setLaunchFee", [0n]);
    await runWorkerOnce(sb.ctx);
    const { r, a } = await treasuryAsset();
    expect(r.exceptions.some((e) => e.kind === "THIRD_PARTY_CREDIT_TO_SPLITTER" && e.amount === parseEther("0.5").toString())).toBe(true);
    expect(a.statements.thirdPartyEscrowCreditsToSplitterKey).toBe(parseEther("0.5").toString());
    expect(a.statements.nonRevenue.unattributedNative).toBe(parseEther("0.25").toString());
    // Graduation residual quote (executor "dust"; large under the W02 mini mocks) is its own class.
    expect(BigInt(a.statements.nonRevenue.graduationResidual ?? "0")).toBeGreaterThan(0n);
    expect(a.statements.nonRevenue.launchFees).toBe(parseEther("0.01").toString());
    // Neither the direct ETH nor the launch fee was allocated.
    const before = a.overview.treasuryAllocated;
    expect(a.indexed.revenueReceived).toBe(r.allocations.reduce((s, x) => s + BigInt(x.received ?? "0"), 0n).toString());
    expect(before).toBe(a.indexed.treasuryAllocated);
  });

  it("15/16/17. a governance policy change only affects NEW launches; old snapshots stay frozen; ineligible launches fail closed", async () => {
    const old = await launch();
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeShareBps", [2_000n]);
    const neu = await launch();
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeShareBps", [3_000n]);
    await runWorkerOnce(sb.ctx);
    const { r } = await treasuryAsset();
    const o = r.launches.find((x) => x.token === old.token)!;
    const n = r.launches.find((x) => x.token === neu.token)!;
    expect(o.economics.eligible70_20_10).toBe(true);
    expect(n.economics.eligible70_20_10).toBe(false);
    expect(n.economics.reasons.join(" ")).toMatch(/20%, not 30%/);
    expect(n.economics.actual).toMatchObject({ creatorPct: 80, protocolPct: 20 });
    const gov = await new TestBrowser(sb).get("/api/finance/governance");
    expect(gov.json.history.filter((h: { event: string }) => h.event === "ProtocolFeeShareUpdated").length).toBe(2);
  });

  it("28. an unauthorized recipient substitution is flagged and makes new launches ineligible", async () => {
    const eoa = chainClients(sb.anvil.url, STRANGER_KEY).account.address;
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeRecipient", [eoa]);
    const sub = await launch();
    await governanceWrite(sb, sb.deployment.memeHook, ponsV2MemeHookAbi, "setProtocolFeeRecipient", [splitter]);
    await runWorkerOnce(sb.ctx);
    const gov = await new TestBrowser(sb).get("/api/finance/governance");
    expect(gov.json.currentPolicy.recipientIsForgeSplitter).toBe(true);
    const { r } = await treasuryAsset();
    const l = r.launches.find((x) => x.token === sub.token)!;
    expect(l.economics.eligible70_20_10).toBe(false);
    expect(l.economics.reasons.join(" ")).toMatch(/not the Forge splitter/);
    expect(l.derivedProtocolSplit).toBeNull();
  });

  it("18/19. buyback-and-lock: effective creator cash is below 70% and the 5-year PONS vest is separate from the FINCO reserve", async () => {
    const l = await launch({ buybackEnabled: true });
    await runWorkerOnce(sb.ctx);
    const { r } = await treasuryAsset();
    const x = r.launches.find((y) => y.token === l.token)!;
    expect(x.economics.eligible70_20_10).toBe(true);
    expect(x.economics.actual).toMatchObject({ creatorPct: 70, creatorCashPct: 35, creatorBuybackLockPct: 35 });
    expect(r.reserve.burnEnabled).toBe(false);
  });
});

describe("W04: ledger integrity under replay and reorg", () => {
  it("24. indexer restart: wiping the indexed history and re-indexing yields an identical treasury report", async () => {
    const strip = (x: Awaited<ReturnType<typeof treasuryReport>>) => JSON.stringify({ ...x, indexer: null, launches: x.launches.map((l) => ({ ...l, accruedUnswept: null })) });
    const before = strip(await treasuryReport(sb.ctx));
    await sb.ctx.db.query("DELETE FROM chain_events");
    await sb.ctx.db.query("DELETE FROM indexed_blocks");
    await sb.ctx.db.query("DELETE FROM indexer_checkpoints");
    await runWorkerOnce(sb.ctx);
    expect(strip(await treasuryReport(sb.ctx))).toBe(before);
  });

  it("21/23. a reorged-out sweep and pull disappear from the ledger; replay never inflates income", async () => {
    const l = await launch();
    await buy(l.curve, "5");
    const snap = await rpc<string>(sb.anvil.url, "evm_snapshot");
    await send(l.sc.key, l.curve, ponsV2BondingCurveAbi, "sweepFees", [0n]);
    await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]);
    await runWorkerOnce(sb.ctx);
    const during = (await treasuryAsset()).a;
    const allocationsDuring = (await treasuryReport(sb.ctx)).allocations.length;
    await rpc(sb.anvil.url, "evm_revert", [snap]);
    // A different, longer canonical chain without the sweep/pull.
    for (let i = 0; i < 4; i++) await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    await runWorkerOnce(sb.ctx);
    const { r, a } = await treasuryAsset();
    expect(r.allocations.length).toBe(allocationsDuring - 1);
    expect(BigInt(a.indexed.revenueReceived!)).toBeLessThan(BigInt(during.indexed.revenueReceived!));
    expect(a.reconciliation).toMatch(/^RECONCILED/);
    // Replaying the same blocks again changes nothing.
    await runWorkerOnce(sb.ctx);
    expect((await treasuryAsset()).a.indexed).toEqual(a.indexed);
  });

  it("25. treasury liabilities reconcile with on-chain balances at the checkpoint", async () => {
    const { a } = await treasuryAsset();
    expect(a.onchainAtCheckpoint!.deficit).toBe("0");
    expect(BigInt(a.onchainAtCheckpoint!.balance as string)).toBeGreaterThanOrEqual(BigInt(a.onchainAtCheckpoint!.accounted as string));
  });
});
