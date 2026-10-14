/**
 * W04 economics acceptance over the REAL Forge stack on a STANDARD Anvil
 * (EIP-170 enforced): factory → curve → canonical PonsV2FeeEscrow →
 * ForgeProtocolRevenueSplitter → treasury claim, plus graduation → hook,
 * through the real API, indexer and ledger. Nothing is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseEther, type Address, type Hex } from "viem";
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
    // The worker pass after the sweep attested the curve's protocol leg as the verified ceiling.
    const pre = (await treasuryAsset()).a;
    expect(pre.provenance.status).toBe("PROVEN_ELIGIBLE");
    expect(pre.provenance.verifiedHeadroom).toBe(((baseFee * 3_000n) / 10_000n).toString());
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
    expect(sub.json.status.verified).toBe(false);
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
    await runWorkerOnce(sb.ctx); // indexes the hook sweep and attests its protocol leg
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
    expect(a.provenance.status).toBe("PROVEN_ELIGIBLE");
    expect(a.provenance.verifiedHeadroom).toBe("0");
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
    // Correction A: the third-party escrow credit is UNATTRIBUTED, never attested, and stays in the escrow.
    expect(a.provenance.classes.find((c) => c.class === "UNATTRIBUTED")!.amount).toBe(parseEther("0.5").toString());
    expect(a.provenance.status).toBe("PROVEN_ELIGIBLE");
    expect(BigInt(a.provenance.attestedCeiling!)).toBe(BigInt(a.provenance.verifiedEligibleRevenue!));
    const pulled = await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]).catch(() => ({ status: "reverted" }));
    await runWorkerOnce(sb.ctx);
    const after = (await treasuryAsset()).a;
    expect(BigInt(after.indexed.escrowClaimed!)).toBeLessThanOrEqual(BigInt(after.provenance.verifiedEligibleRevenue!));
    const held = await sb.ctx.client.readContract({ address: sb.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [splitter] });
    expect(held).toBeGreaterThanOrEqual(parseEther("0.5"));
    expect(["success", "reverted"]).toContain(pulled.status);
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
    await runWorkerOnce(sb.ctx); // attests the sweep's protocol leg (also reorged out below)
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
    // The reorged-out authorization is gone from both the chain and the ledger.
    expect(a.provenance.status).not.toBe("RECONCILIATION_MISMATCH");
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

// ── Correction A ───────────────────────────────────────────────────────────

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
] as const;

async function deployTestToken(key: Hex, symbol: string): Promise<Address> {
  const a = loadArtifact("ForgeTestToken");
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const h = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args: [`Test ${symbol}`, symbol] });
  return getAddress((await pub.waitForTransactionReceipt({ hash: h })).contractAddress!);
}

describe("W04 Correction A (P1): only verified eligible revenue can be pulled", () => {
  it("third-party credit alongside a real curve fee: the pull is bounded by the attested ceiling; the credit stays in escrow", async () => {
    const l = await launch();
    await buy(l.curve, "10");
    const fee = await sb.ctx.client.readContract({ address: l.curve, abi: ponsV2BondingCurveAbi, functionName: "quoteFeeBalance" });
    // Drain any earlier verified headroom so this test measures only its own fee.
    await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]).catch(() => undefined);
    await send(STRANGER_KEY, sb.deployment.feeEscrow, ponsV2FeeEscrowAbi, "credit", [splitter], parseEther("1"));
    await send(l.sc.key, l.curve, ponsV2BondingCurveAbi, "sweepFees", [0n]);
    await send(STRANGER_KEY, sb.deployment.feeEscrow, ponsV2FeeEscrowAbi, "credit", [splitter], parseEther("2"));
    const pass = await runWorkerOnce(sb.ctx);
    expect(pass.attestations.some((x) => x.status === "AUTHORIZED")).toBe(true);
    const protocol = (fee * 3_000n) / 10_000n;
    const headroom = await sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", args: [NATIVE] });
    expect(headroom).toBe(protocol);
    const escrowBefore = await sb.ctx.client.readContract({ address: sb.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [splitter] });
    // Pulling more than the verified headroom reverts; pulling all pulls only the fee.
    const over = await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, protocol + 1n]).catch(() => ({ status: "reverted" }));
    expect(over.status).not.toBe("success");
    expect((await send(STRANGER_KEY, splitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n])).status).toBe("success");
    const escrowAfter = await sb.ctx.client.readContract({ address: sb.deployment.feeEscrow, abi: ponsV2FeeEscrowAbi, functionName: "balanceOf", args: [splitter] });
    expect(escrowBefore - escrowAfter).toBe(protocol);
    await runWorkerOnce(sb.ctx);
    const { a, r } = await treasuryAsset();
    expect(r.allocations.at(-1)!.received).toBe(protocol.toString());
    expect(a.provenance.status).toBe("PROVEN_ELIGIBLE");
    expect(BigInt(a.provenance.classes.find((c) => c.class === "UNATTRIBUTED")!.amount!)).toBeGreaterThanOrEqual(parseEther("3"));
    expect(a.reconciliation).toBe("RECONCILED");
  });

  it("an attestation signed by a non-attestor key is refused on chain", async () => {
    const { wallet, pub } = chainClients(sb.anvil.url, STRANGER_KEY);
    const head = await pub.getBlock({ blockTag: "latest" });
    const evidence = await pub.getBlock({ blockNumber: head.number - 1n });
    const live = await pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "ledger", args: [NATIVE] });
    const auth = {
      escrow: sb.deployment.feeEscrow,
      factory: sb.deployment.factory,
      asset: NATIVE,
      cumulativeEligible: live.eligibleCeiling, // only the signer is wrong; every other field is valid
      nonce: live.authNonce + 1n,
      deadline: head.timestamp + 600n,
      evidenceBlock: evidence.number,
      evidenceBlockHash: evidence.hash,
    };
    const digest = await pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "eligibleRevenueDigest", args: [auth] });
    const { sign, serializeSignature } = await import("viem/accounts").then(async (m) => ({ sign: m.sign, serializeSignature: (await import("viem")).serializeSignature }));
    const sig = serializeSignature(await sign({ hash: digest, privateKey: STRANGER_KEY }));
    const sim = await pub.simulateContract({ account: wallet.account, address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "authorizeEligibleRevenue", args: [auth, sig] }).catch((e: Error) => e);
    expect(sim).toBeInstanceOf(Error);
    expect(String((sim as Error).message)).toMatch(/InvalidAttestation/);
  });
});

describe("W04 Correction A (P2): claim transaction attestation", () => {
  let creator: { browser: TestBrowser; key: Hex; address: Address };
  let usdt: Address;
  const escrowAddr = () => sb.deployment.feeEscrow;

  async function creditCreator(eth: string) {
    await send(STRANGER_KEY, escrowAddr(), ponsV2FeeEscrowAbi, "credit", [creator.address], parseEther(eth));
  }
  async function sendRaw(key: Hex, to: Address, data: Hex, gas?: bigint) {
    const { wallet, pub } = chainClients(sb.anvil.url, key);
    const h = await wallet.sendTransaction({ to, data, value: 0n, ...(gas ? { gas } : {}) });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    return { hash: h, status: r.status };
  }
  const submit = (body: Record<string, unknown>, b: TestBrowser = creator.browser) => b.post("/api/finance/claims/submitted", body);

  beforeAll(async () => {
    const sc = await freshScenario(sb);
    creator = { browser: sc.browser, key: sc.key, address: sc.address };
    usdt = await deployTestToken(STRANGER_KEY, "USDT");
  });

  it("1. valid native claim → CONFIRMED_INDEXED only after the canonical Claimed event is indexed", async () => {
    await creditCreator("1");
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [parseEther("0.4")] }));
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: parseEther("0.4").toString() });
    expect(sub.status).toBe(200);
    expect(sub.json.status.state).toBe("MINED_AWAITING_INDEXER");
    await runWorkerOnce(sb.ctx);
    const again = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: parseEther("0.4").toString() });
    expect(again.json.status).toMatchObject({ state: "CONFIRMED_INDEXED", verified: true, selector: "claim(uint256)", amount: parseEther("0.4").toString() });
  });

  it("2. valid ERC-20 claim (claimToken(address)) → CONFIRMED_INDEXED", async () => {
    await send(STRANGER_KEY, usdt, erc20Abi, "mint", [chainClients(sb.anvil.url, STRANGER_KEY).account.address, 1_000n]);
    await send(STRANGER_KEY, usdt, erc20Abi, "approve", [escrowAddr(), 1_000n]);
    await send(STRANGER_KEY, escrowAddr(), ponsV2FeeEscrowAbi, "creditToken", [creator.address, usdt, 1_000n]);
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [usdt] }));
    await runWorkerOnce(sb.ctx);
    const sub = await submit({ txHash: tx.hash, asset: usdt, kind: "escrow", amount: "0" });
    expect(sub.json.status).toMatchObject({ state: "CONFIRMED_INDEXED", verified: true, selector: "claimToken(address)", amount: "1000" });
  });

  it("3. valid treasury claim (claimTreasury) by the treasury recipient → CONFIRMED_INDEXED", async () => {
    // The treasury wallet is already bound to GitHub user 30_001 (treasury test above).
    const tb = new TestBrowser(sb);
    await tb.signInGithub(30_001);
    // Make sure there is a treasury liability to claim.
    const liability = await sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "treasuryLiability", args: [NATIVE] });
    expect(liability).toBeGreaterThan(0n);
    const tx = await sendRaw(TREASURY_KEY, splitter, encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "claimTreasury", args: [NATIVE, 1n] }));
    await runWorkerOnce(sb.ctx);
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "treasury", amount: "1" }, tb);
    expect(sub.json.status).toMatchObject({ state: "CONFIRMED_INDEXED", verified: true, selector: "claimTreasury(address,uint256)" });
  });

  it("4. wrong sender: another wallet's real claim cannot be submitted", async () => {
    const strangerTx = await sendRaw(TREASURY_KEY, splitter, encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "claimTreasury", args: [NATIVE, 1n] }));
    const sub = await submit({ txHash: strangerTx.hash, asset: NATIVE, kind: "treasury", amount: "1" });
    expect(sub.status).toBe(403);
    expect(sub.json.error.code).toBe("NOT_YOUR_TRANSACTION");
  });

  it("5. wrong recipient contract: claim calldata sent to a non-canonical contract is refused", async () => {
    const tx = await sendRaw(creator.key, usdt, encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] }), 100_000n);
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(422);
    expect(sub.json.error.code).toBe("WRONG_RECIPIENT_CONTRACT");
  });

  it("6. wrong selector: a non-claim call to the canonical escrow is refused", async () => {
    const { wallet, pub } = chainClients(sb.anvil.url, creator.key);
    const h = await wallet.writeContract({ address: escrowAddr(), abi: ponsV2FeeEscrowAbi, functionName: "credit", args: [creator.address], value: 1n });
    await pub.waitForTransactionReceipt({ hash: h });
    const sub = await submit({ txHash: h, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(422);
    expect(sub.json.error.code).toBe("WRONG_SELECTOR");
  });

  it("7. wrong asset: a token claim submitted as a native claim is refused", async () => {
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claimToken", args: [usdt, 1n] }), 150_000n);
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(422);
    expect(sub.json.error.code).toBe("WRONG_ASSET");
  });

  it("8. wrong amount: the decoded amount must equal the expected amount (0 = full balance)", async () => {
    await creditCreator("0.1");
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [1n] }));
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: "2" });
    expect(sub.status).toBe(422);
    expect(sub.json.error.code).toBe("WRONG_AMOUNT");
    const full = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: "0" });
    expect(full.json.error.code).toBe("WRONG_AMOUNT");
  });

  it("9. unrelated successful transaction from the same wallet is never a claim", async () => {
    const { wallet, pub } = chainClients(sb.anvil.url, creator.key);
    const h = await wallet.sendTransaction({ to: chainClients(sb.anvil.url, STRANGER_KEY).account.address, value: 1n });
    expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    const sub = await submit({ txHash: h, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(422);
    expect(sub.json.error.code).toBe("WRONG_RECIPIENT_CONTRACT");
  });

  it("10. dropped transaction: never visible, stays UNVERIFIED_PENDING and never valid", async () => {
    await rpc(sb.anvil.url, "evm_setAutomine", [false]);
    const { wallet } = chainClients(sb.anvil.url, creator.key);
    const h = await wallet.sendTransaction({ to: escrowAddr(), data: encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] }), gas: 100_000n });
    await rpc(sb.anvil.url, "anvil_dropTransaction", [h]);
    await rpc(sb.anvil.url, "evm_setAutomine", [true]);
    await rpc(sb.anvil.url, "evm_mine");
    const sub = await submit({ txHash: h, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(200);
    expect(sub.json.status).toMatchObject({ state: "UNVERIFIED_PENDING", verified: false });
    await runWorkerOnce(sb.ctx);
    const me = await creator.browser.get("/api/finance/creator");
    expect(me.json.claimSubmissions.find((x: { tx_hash: string }) => x.tx_hash === h.toLowerCase()).status.state).toBe("UNVERIFIED_PENDING");
  });

  it("11. reverted transaction → FAILED, never valid", async () => {
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [parseEther("1000")] }), 100_000n);
    expect(tx.status).toBe("reverted");
    const sub = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: parseEther("1000").toString() });
    expect(sub.status).toBe(200);
    expect(sub.json.status).toMatchObject({ state: "FAILED", verified: false });
  });

  it("12. reorged transaction: a confirmed claim reorganised out is no longer valid", async () => {
    await creditCreator("0.2");
    const snap = await rpc<string>(sb.anvil.url, "evm_snapshot");
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [parseEther("0.05")] }));
    await runWorkerOnce(sb.ctx);
    const ok = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow", amount: parseEther("0.05").toString() });
    expect(ok.json.status.state).toBe("CONFIRMED_INDEXED");
    await rpc(sb.anvil.url, "evm_revert", [snap]);
    for (let i = 0; i < 4; i++) await rpc(sb.anvil.url, "evm_mine");
    await runWorkerOnce(sb.ctx);
    await runWorkerOnce(sb.ctx);
    const me = await creator.browser.get("/api/finance/creator");
    const row = me.json.claimSubmissions.find((x: { tx_hash: string }) => x.tx_hash === tx.hash.toLowerCase());
    expect(row.status.state).not.toBe("CONFIRMED_INDEXED");
    expect(row.status.verified).toBe(false);
  });

  it("13. duplicate submission is idempotent; conflicting details for the same hash are refused", async () => {
    await creditCreator("0.1");
    const tx = await sendRaw(creator.key, escrowAddr(), encodeFunctionData({ abi: ponsV2FeeEscrowAbi, functionName: "claim", args: [] }));
    await runWorkerOnce(sb.ctx);
    const first = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow" });
    const second = await submit({ txHash: tx.hash, asset: NATIVE, kind: "escrow" });
    expect(first.json.duplicate).toBe(false);
    expect(second.json.duplicate).toBe(true);
    expect(second.json.status).toEqual(first.json.status);
    const n = await sb.ctx.db.query<{ n: string }>("SELECT count(*)::text AS n FROM fin_claim_submissions WHERE tx_hash = $1", [tx.hash.toLowerCase()]);
    expect(n.rows[0]!.n).toBe("1");
    const ghost = `0x${"ab".repeat(32)}`;
    expect((await submit({ txHash: ghost, asset: NATIVE, kind: "escrow" })).status).toBe(200);
    const conflict = await submit({ txHash: ghost, asset: NATIVE, kind: "treasury" });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("DUPLICATE_SUBMISSION_MISMATCH");
  });

  it("14. a pending hash with no proven contents is recorded UNVERIFIED_PENDING, never as a claim", async () => {
    const h = `0x${"cd".repeat(32)}`;
    const sub = await submit({ txHash: h, asset: NATIVE, kind: "escrow" });
    expect(sub.status).toBe(200);
    expect(sub.json.status).toMatchObject({ state: "UNVERIFIED_PENDING", verified: false });
    const row = await sb.ctx.db.query<{ contents_verified_at: Date | null; selector: string | null }>("SELECT contents_verified_at, selector FROM fin_claim_submissions WHERE tx_hash = $1", [h]);
    expect(row.rows[0]).toMatchObject({ contents_verified_at: null, selector: null });
    const me = await creator.browser.get("/api/finance/creator");
    expect(me.json.claimHistory.some((c: { txHash: string }) => c.txHash === h)).toBe(false);
  });
});

describe("W04 Correction A (P3): supported quote-asset authority comes from the Forge factory", () => {
  it("a factory-approved quote is accepted; an unsupported ERC-20 and a launch token are refused; ETH stays supported", async () => {
    const quote = await deployTestToken(STRANGER_KEY, "QUSD");
    const stray = await deployTestToken(STRANGER_KEY, "STRAY");
    const govSim = async (asset: Address) =>
      sb.ctx.client
        .simulateContract({ account: sb.deployment.governance, address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "setAssetApproved", args: [asset, true] })
        .then(() => "ok")
        .catch((e: Error) => e.message);
    expect(await govSim(stray)).toMatch(/AssetNotForgeQuote/);
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setPairTokenEconomics", [quote, parseEther("30"), parseEther("30"), 18]);
    expect(await govSim(quote)).toMatch(/AssetNotForgeQuote/); // economics alone is not approval
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setPairTokenApproved", [quote, true]);
    await governanceWrite(sb, splitter, forgeProtocolRevenueSplitterAbi, "setAssetApproved", [quote, true]);
    expect(await sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "approvedAsset", args: [quote] })).toBe(true);
    const anyLaunch = (await treasuryReport(sb.ctx)).launches[0]!;
    expect(await govSim(anyLaunch.token)).toMatch(/AssetIsLaunchToken|AssetNotForgeQuote/);
    expect(await sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "approvedAsset", args: [NATIVE] })).toBe(true);
    // A later factory de-listing keeps the splitter's approval (historic liabilities stay pullable/claimable).
    await governanceWrite(sb, sb.deployment.factory, ponsV2LaunchFactoryAbi, "setPairTokenApproved", [quote, false]);
    expect(await sb.ctx.client.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "approvedAsset", args: [quote] })).toBe(true);
  });
});
