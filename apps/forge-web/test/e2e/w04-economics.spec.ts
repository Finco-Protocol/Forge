/**
 * W04 browser E2E over the production build (runs after launch.spec.ts and
 * uses the token that spec launched for anvil account #5 with a 1% creator
 * tax): trades → fee sweep → the worker attests the verified protocol leg
 * (Correction A) → splitter pull → the creator claims their escrow
 * balance from the dashboard with their own wallet → the treasury dashboard
 * shows reconciled 70/20/10 accounting with the FINCO burn disabled.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseEther, type Hex } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi } from "../../src/shared/abis.generated";

const CREATOR = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // anvil #5
const BUYER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9"; // anvil #6
const KEEPER = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"; // anvil #7 (anyone may pull)
const NATIVE = "0x0000000000000000000000000000000000000000";
const SHOTS = path.resolve(process.cwd(), "test-results", "screens");
mkdirSync(SHOTS, { recursive: true });

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(process.env.E2E_ANVIL_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Anvil's dev accounts are unlocked: eth_sendTransaction signs with the node key. */
async function sendTx(from: string, to: string, data: Hex, value = 0n) {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data, value: `0x${value.toString(16)}` }]);
  for (let i = 0; i < 50; i++) {
    const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (r) {
      expect(r.status).toBe("0x1");
      return hash;
    }
    await new Promise((x) => setTimeout(x, 100));
  }
  throw new Error(`tx ${hash} not mined`);
}

async function injectWallet(page: Page, account: string) {
  await page.addInitScript(
    ({ rpc, account }) => {
      let id = 0;
      const forward = async (method: string, params: unknown[] = []) => {
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
        return j.result;
      };
      (window as unknown as { ethereum: unknown }).ethereum = {
        isForgeTestWallet: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
          if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
          return forward(method, params ?? []);
        },
        on: () => undefined,
        removeListener: () => undefined,
      };
    },
    { rpc: process.env.E2E_ANVIL_URL!, account },
  );
}

test("creator claims eligible earnings and the treasury reconciles 70/20/10 (burn disabled)", async ({ page, baseURL }) => {
  // The previous spec left the fake GitHub logged in as bob; sign in as alice (the creator).
  await fetch(`${process.env.E2E_FAKE_GITHUB_URL}/__control/login-as`, { method: "POST", body: JSON.stringify({ userId: 1001 }) });
  const tokens = (await (await fetch(`${baseURL}/api/tokens`)).json()) as { tokens: Array<{ token: string; curve: string; creator: string }> };
  const launched = tokens.tokens.find((t) => t.creator.toLowerCase() === CREATOR.toLowerCase());
  expect(launched, "launch.spec.ts must have launched a token for anvil #5").toBeTruthy();
  const curve = launched!.curve;
  const cfg = (await (await fetch(`${baseURL}/api/config`)).json()) as { addresses: Record<string, string> };
  const splitter = cfg.addresses.revenueSplitter!;

  // Past the anti-snipe window, then a 10 ETH buy (1% base fee + 1% creator tax).
  await rpc("evm_increaseTime", [30]);
  await rpc("evm_mine");
  await sendTx(BUYER, curve, encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("10"), 0n, BUYER] }), parseEther("10"));
  await sendTx(CREATOR, curve, encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "sweepFees", args: [0n] }));
  // Correction A: pulls are bounded by the attested ceiling; the embedded worker attests the sweep's protocol leg.
  const headroomCall = encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", args: [NATIVE] });
  await expect
    .poll(async () => decodeFunctionResult({ abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", data: await rpc<Hex>("eth_call", [{ to: splitter, data: headroomCall }, "latest"]) }), { timeout: 60_000 })
    .toBeGreaterThan(0n);
  await sendTx(KEEPER, splitter, encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "pullRevenue", args: [NATIVE, 0n] }));

  await injectWallet(page, CREATOR);
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "Connect GitHub" }).click();
  await page.waitForURL("**/launch");
  await page.goto("/dashboard");
  await expect(page.getByTestId("creator-earnings")).toBeVisible();
  await expect(page.getByTestId("eligible-70-20-10").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("claimable-ETH")).not.toHaveText(/^0 ETH$/, { timeout: 30_000 });
  await expect(page.getByTestId("reconciliation").first()).toContainText("reconciled");
  await page.screenshot({ path: `${SHOTS}/12-creator-earnings.png`, fullPage: true });

  await page.getByTestId("prepare-claim-ETH").click();
  await expect(page.getByTestId("claim-preview")).toContainText("canonical escrow");
  await page.screenshot({ path: `${SHOTS}/13-claim-preview.png`, fullPage: true });
  const connect = page.getByTestId("claim-connect-wallet");
  if (await connect.isVisible()) await connect.click();
  await page.getByTestId("send-claim").click();
  await expect(page.getByTestId("claim-status").first()).toHaveText(/CONFIRMED_INDEXED/, { timeout: 60_000 });
  await expect(page.getByTestId("claimable-ETH")).toHaveText("0 ETH", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/14-claim-confirmed.png`, fullPage: true });

  await page.goto("/treasury");
  await expect(page.getByTestId("treasury-overview")).toBeVisible();
  await expect(page.getByTestId("reserve-status")).toContainText("DISABLED");
  await expect(page.getByTestId("treasury-allocated-ETH")).not.toHaveText(/^0 ETH$/);
  await expect(page.getByTestId("reconciliation").first()).toContainText("reconciled");
  await expect(page.getByTestId("provenance").first()).toContainText("proven eligible");
  await page.screenshot({ path: `${SHOTS}/15-treasury-overview.png`, fullPage: true });
  await page.getByTestId("tab-launches").click();
  await expect(page.getByTestId("treasury-launches")).toContainText("70 / 20 / 10 eligible");
  await page.screenshot({ path: `${SHOTS}/16-treasury-launches.png`, fullPage: true });
  await page.getByTestId("tab-accounting").click();
  await expect(page.getByTestId("allocation-history")).toContainText("1");
  await expect(page.getByTestId("provenance-ETH")).toContainText("Not trustless");
  await page.screenshot({ path: `${SHOTS}/17-treasury-accounting.png`, fullPage: true });
  await page.getByTestId("tab-governance").click();
  await expect(page.getByTestId("burn-enabled")).toContainText("false");
  await expect(page.getByTestId("authorization-matrix")).toContainText("setCreatorFeeRecipient");
  await page.screenshot({ path: `${SHOTS}/18-treasury-governance.png`, fullPage: true });
});
