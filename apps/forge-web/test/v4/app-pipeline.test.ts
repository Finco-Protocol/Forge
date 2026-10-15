/**
 * W05: the W03/W04 APPLICATION pipeline (API launch, indexer, ledger, the
 * worker's own revenue attestor, treasury report) over a Forge stack wired to
 * the GENUINE Uniswap V4 contracts. Mirrors economics.test.ts case 20, but the
 * pool is a genuine v4-core PoolManager pool seeded through the genuine
 * PositionManager + Permit2, and the swap goes through Uniswap's own
 * PoolSwapTest — no mini mocks, no anvil_setBalance on the pool manager.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi, ponsV2MemeHookAbi } from "@/shared/abis.generated";
import { runWorkerOnce } from "@/server/worker";
import { treasuryReport } from "@/server/finance/service";
import { startSandbox, chainClients, ANVIL_KEYS, type Sandbox } from "../helpers/sandbox";
import { rpc } from "../helpers/anvil";
import { freshScenario, launchThroughApi } from "../helpers/scenario";
import { deploySandbox } from "../../scripts/sandbox-lib";
import { deployGenuineV4Local } from "../../scripts/w05/genuine-v4";
import { GENUINE } from "../../scripts/w05/uniswap-artifacts";
import { ERC20, MAX_SQRT_PRICE, poolIdOf } from "./lifecycle";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const BUYER_KEY = ANVIL_KEYS[6];
const STRANGER_KEY = ANVIL_KEYS[7];
let sb: Sandbox;

beforeAll(async () => {
  sb = await startSandbox({}, {
    deploy: async (url) => {
      const v4 = await deployGenuineV4Local(url);
      return deploySandbox(url, { v4: { poolManager: v4.poolManager, positionManager: v4.positionManager, permit2: v4.permit2 }, hookVia: "create2-proxy" });
    },
  });
});
afterAll(async () => sb?.stop());

async function send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], value = 0n) {
  const { wallet, pub } = chainClients(sb.anvil.url, key);
  const h = await wallet.writeContract({ address, abi, functionName, args, value } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

describe("W05: app pipeline over GENUINE Uniswap V4 (local-genuine)", () => {
  it("API launch → curve → graduation (genuine PositionManager) → genuine swap → hook fee → worker attests → splitter pull → RECONCILED", async () => {
    expect(sb.deployment.v4Source).toBe("GENUINE_UNISWAP_V4");
    const sc = await freshScenario(sb);
    const l = await launchThroughApi(sb, sc.browser, sc.key, { ...sc.draft, creatorTaxBps: 100 });
    expect(l.submitted.status).toBe(200);
    const token = getAddress(l.submitted.json.token);
    const curve = getAddress(l.submitted.json.curve);
    await runWorkerOnce(sb.ctx);
    await rpc(sb.anvil.url, "evm_increaseTime", [20]);
    await rpc(sb.anvil.url, "evm_mine");
    const buyer = chainClients(sb.anvil.url, BUYER_KEY);
    for (const eth of ["5", "100"]) await send(BUYER_KEY, curve, ponsV2BondingCurveAbi, "buy", [parseEther(eth), 0n, buyer.account.address], parseEther(eth));
    const phase = (await sb.ctx.client.readContract({ address: sb.deployment.factory, abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchedToken", args: [token] })).phase;
    if (phase === 0) await send(BUYER_KEY, sb.deployment.factory, ponsV2LaunchFactoryAbi, "graduate", [token]);
    await send(BUYER_KEY, sb.deployment.factory, ponsV2LaunchFactoryAbi, "createGraduatedPool", [token]);
    await runWorkerOnce(sb.ctx);
    const before = (await treasuryReport(sb.ctx)).launches.find((x) => x.token === token)!;
    const key = { currency0: NATIVE, currency1: token, fee: 0, tickSpacing: 10, hooks: sb.deployment.memeHook };
    expect(before.poolId).toBe(poolIdOf(key));

    const router = GENUINE.poolSwapTest();
    const dh = await buyer.wallet.deployContract({ abi: router.abi, bytecode: router.bytecode, args: [sb.deployment.poolManager] } as never);
    const routerAddr = (await buyer.pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
    const held = (await sb.ctx.client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [buyer.account.address] })) as bigint;
    await send(BUYER_KEY, token, ERC20, "approve", [routerAddr, held / 4n]);
    await send(BUYER_KEY, routerAddr, router.abi, "swap", [key, { zeroForOne: false, amountSpecified: -(held / 4n), sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"]);
    const pid = before.poolId as Hex;
    const pendingQuote = await sb.ctx.client.readContract({ address: sb.deployment.memeHook, abi: ponsV2MemeHookAbi, functionName: "pendingFees", args: [pid, NATIVE] });
    expect(pendingQuote).toBeGreaterThan(0n);
    await send(sc.key, sb.deployment.memeHook, ponsV2MemeHookAbi, "sweepPoolFees", [pid, 0n, 0n]);
    const pass = await runWorkerOnce(sb.ctx); // indexes the hook sweep and attests its protocol leg (the app's own attestor)
    expect(JSON.stringify(pass)).toContain("AUTHORIZED");
    await send(STRANGER_KEY, sb.deployment.revenueSplitter, forgeProtocolRevenueSplitterAbi, "pullRevenue", [NATIVE, 0n]);
    await runWorkerOnce(sb.ctx);

    const r = await treasuryReport(sb.ctx);
    const a = r.accounting.find((x) => x.asset.asset === NATIVE)!;
    const t = r.launches.find((x) => x.token === token)!;
    expect(BigInt(t.v4Hook.baseFeesQuote!)).toBe(pendingQuote);
    expect(t.v4Hook.sweeps).toBe(1);
    expect(BigInt(t.credited.protocol!) - BigInt(before.credited.protocol!)).toBe((pendingQuote * 3_000n) / 10_000n);
    expect(t.credited.creatorUnsplit).toBe("0");
    expect(a.reconciliation).toBe("RECONCILED");
    expect(a.provenance.status).toBe("PROVEN_ELIGIBLE");
    expect(a.provenance.verifiedHeadroom).toBe("0");
    // Under the GENUINE PositionManager the graduation residual is rounding dust (the W02 mini mocks left a large residual).
    const residual = BigInt(a.statements.nonRevenue.graduationResidual ?? "0");
    console.log(`W05_APP_PIPELINE graduationResidualWei=${residual} hookBaseFeesQuote=${pendingQuote}`);
    expect(residual).toBeLessThan(parseEther("0.000001"));
    const me = await sc.browser.get("/api/finance/creator");
    const row = me.json.launches.find((x: { token: string }) => x.token === token);
    expect(BigInt(row.earnedIndexed.byOrigin.v4Hook)).toBeGreaterThan(0n);
  });
});
