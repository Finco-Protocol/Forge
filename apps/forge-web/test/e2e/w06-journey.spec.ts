/**
 * W06 full user-journey E2E in a real browser against the production build
 * (`next start`), the real route handlers, a real database and the embedded
 * worker/indexer.
 *
 * SIMULATED (never production evidence): the chain is a local Anvil with the
 * W02 sandbox contracts and the sandbox (mock) V4 pool; GitHub is the
 * in-process FakeGithub; the wallet is an EIP-1193 provider that forwards to
 * Anvil's unlocked dev accounts. The application has no trading screen
 * (trading is on-chain; the UI shows the observed curve state), so trades,
 * graduation and fee sweeps are sent as plain transactions and the browser
 * verifies what the application then displays.
 *
 * Every step records what the browser actually showed in
 * test-results/w06-journey-observed.json (+ screenshots).
 */
import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseEther, type Hex } from "viem";
import { forgeBindingRegistryAbi, forgeProtocolRevenueSplitterAbi, ponsV2BondingCurveAbi, ponsV2LaunchFactoryAbi } from "../../src/shared/abis.generated";

const CREATOR = "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"; // anvil #9
const OTHER_WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil #2
const BUYER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9"; // anvil #6
const KEEPER = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"; // anvil #7
const NATIVE = "0x0000000000000000000000000000000000000000";
const GH = process.env.E2E_FAKE_GITHUB_URL!;
const SHOTS = path.resolve(process.cwd(), "test-results", "screens-w06");
const OBSERVED = path.resolve(process.cwd(), "test-results", "w06-journey-observed.json");
mkdirSync(SHOTS, { recursive: true });

const observed: Array<{ step: string; expected: string; observed: string; simulated?: string }> = [];
const note = (step: string, expected: string, obs: string, simulated?: string) => observed.push({ step, expected, observed: obs, ...(simulated ? { simulated } : {}) });
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.jpg`, type: "jpeg", quality: 55, fullPage: true });

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(process.env.E2E_ANVIL_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function sendTx(from: string, to: string, data: Hex, value = 0n) {
  const hash = await rpc<Hex>("eth_sendTransaction", [{ from, to, data, value: `0x${value.toString(16)}` }]);
  for (let i = 0; i < 80; i++) {
    const r = await rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") {
        const tx = await rpc<{ from: string; to: string; input: string; value: string; blockNumber: string }>("eth_getTransactionByHash", [hash]);
        const why = await rpc("eth_call", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, `0x${(BigInt(tx.blockNumber) - 1n).toString(16)}`]).then(() => "(replay did not revert)", (e: Error) => e.message);
        throw new Error(`tx ${hash} to ${tx.to} reverted: ${why}`);
      }
      return hash;
    }
    await new Promise((x) => setTimeout(x, 100));
  }
  throw new Error(`tx ${hash} not mined`);
}
const ghControl = (action: string, body: unknown) => fetch(`${GH}/__control/${action}`, { method: "POST", body: JSON.stringify(body) });
const loginAs = (userId: number) => ghControl("login-as", { userId });
async function webhook(baseURL: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", "test-webhook-secret-0123456789").update(body).digest("hex");
  return fetch(`${baseURL}/api/github/webhook`, { method: "POST", headers: { "x-hub-signature-256": sig, "x-github-delivery": crypto.randomUUID(), "x-github-event": event, "content-type": "application/json" }, body });
}

interface WalletOpts {
  chainIdHex?: string;
  badTypedDataSignature?: boolean;
  failSendTransaction?: boolean;
}
async function injectWallet(page: Page, account: string, opts: WalletOpts = {}) {
  await page.addInitScript(
    ({ rpc, account, opts }) => {
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
          // Count every transaction the page asks the wallet to submit (attempted or not):
          // the double-submission guard is proven by this counter, not by token counts.
          if (method === "eth_sendTransaction") {
            const w = window as unknown as { __ethSendTxCount?: number };
            w.__ethSendTxCount = (w.__ethSendTxCount ?? 0) + 1;
          }
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "eth_chainId" && opts.chainIdHex) return opts.chainIdHex;
          if (method === "net_version" && opts.chainIdHex) return String(parseInt(opts.chainIdHex, 16));
          if (method === "wallet_switchEthereumChain") {
            if (opts.chainIdHex) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            return null;
          }
          if (method === "wallet_addEthereumChain") return null;
          if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
          if (method === "eth_signTypedData_v4" && opts.badTypedDataSignature) return "0x" + "11".repeat(64) + "1b";
          if (method === "eth_sendTransaction" && opts.failSendTransaction) throw Object.assign(new Error("execution reverted: simulated failure"), { code: -32000 });
          return forward(method, params ?? []);
        },
        on: () => undefined,
        removeListener: () => undefined,
      };
    },
    { rpc: process.env.E2E_ANVIL_URL!, account, opts },
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(o.sw, "horizontal overflow").toBeLessThanOrEqual(o.cw + 1);
}

/** Drives the launch wizard up to a verified, bound repository. */
async function signInAndVerify(page: Page, repoId: number, repoName: string) {
  await page.goto("/launch");
  const connect = page.getByTestId("connect-github");
  await page.waitForLoadState("networkidle");
  if (await connect.isVisible().catch(() => false)) {
    await connect.click();
    await page.waitForURL("**/launch");
  }
  await expect(page.getByTestId("account-status")).toContainText("@carol-admin");
  // wagmi may already have reconnected the injected wallet: act only on what is on screen
  const cw = page.getByTestId("connect-wallet"), bw = page.getByTestId("bind-wallet"), bound = page.getByTestId("wallet-bound");
  await expect(cw.or(bw).or(bound).first()).toBeVisible();
  if (await cw.isVisible()) await cw.click();
  await expect(bw.or(bound).first()).toBeVisible();
  if (await bw.isVisible()) await bw.click();
  await expect(bound).toContainText(CREATOR);
  await page.getByTestId(`repo-${repoId}`).click();
  await expect(page.getByTestId("eligibility-result")).toContainText(repoName);
}
async function configure(page: Page, name: string, symbol: string) {
  await page.getByTestId("to-configure").click();
  await page.getByTestId("f-name").fill(name);
  await page.getByTestId("f-symbol").fill(symbol);
  await page.getByTestId("f-tax").fill("100");
  await page.getByTestId("preview").click();
  await expect(page.getByTestId("economics")).toContainText("Graduation threshold");
}

test.describe.configure({ mode: "serial" });

let token = "";
let curve = "";
let splitter = "";
let registry = "";

test.afterAll(() => {
  writeFileSync(OBSERVED, JSON.stringify({ kind: "w06-journey-observed", simulated: ["chain: local Anvil + W02 sandbox contracts + sandbox (mock) V4 pool", "GitHub: in-process FakeGithub", "wallet: EIP-1193 provider forwarding to Anvil unlocked accounts"], steps: observed }, null, 2));
});

test("J01-J09 connect wallet, GitHub auth, repository admin proof, binding, eligibility, configure, economics, authorized launch", async ({ page, baseURL }) => {
  await loginAs(1003);
  const cfg = (await (await fetch(`${baseURL}/api/config`)).json()) as { addresses: Record<string, string> };
  splitter = cfg.addresses.revenueSplitter!;
  registry = cfg.addresses.registry!;
  await injectWallet(page, CREATOR);
  await page.goto("/launch");
  await expect(page.getByTestId("connect-github")).toBeVisible();
  await shot(page, "J01-launch-signed-out");
  await page.getByTestId("connect-github").click();
  await page.waitForURL("**/launch");
  await expect(page.getByTestId("account-status")).toContainText("@carol-admin");
  note("J02 GitHub auth", "signed in as carol-admin", "account-status shows @carol-admin", "FakeGithub OAuth");
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("bind-wallet").click();
  await expect(page.getByTestId("wallet-bound")).toContainText(CREATOR);
  note("J01/J05 wallet connect + bind", "SIWE-bound creator wallet", `wallet-bound shows ${CREATOR}`);
  await page.getByTestId("repo-5003").click();
  await expect(page.getByTestId("eligibility-result")).toContainText("finco-labs/journey-main");
  await shot(page, "J04-repository-admin-proof");
  note("J03/J04/J06 repository selection, admin proof, eligibility", "Eligible. administration confirmed by token and installation", (await page.getByTestId("eligibility-result").innerText()).split("\n")[0]!, "FakeGithub");

  await configure(page, "Journey Token", "JRNY");
  const econ = await page.getByTestId("economics").innerText();
  expect(econ).toMatch(/creator/i);
  await shot(page, "J07-J08-configure-and-economics");
  note("J07/J08 configure + transparent economics", "creator and protocol economics shown before signing", econ.replace(/\s+/g, " ").slice(0, 240));
  const predicted = (await page.getByTestId("predicted-token").textContent())!.trim();

  await page.getByTestId("authorize").click();
  await expect(page.getByTestId("authorization")).toContainText("epoch 1");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("simulation")).toContainText(predicted);
  await shot(page, "J09-authorized-and-simulated");
  await page.getByTestId("launch").click();
  await expect(page.getByTestId("launch-state")).toHaveText("confirmed", { timeout: 60_000 });
  await shot(page, "J09-launched");
  const tokens = (await (await fetch(`${baseURL}/api/tokens`)).json()) as { tokens: Array<{ token: string; curve: string; creator: string }> };
  const mine = tokens.tokens.filter((t) => t.creator.toLowerCase() === CREATOR.toLowerCase());
  expect(mine.length, "exactly one token for the creator").toBe(1);
  token = mine[0]!.token;
  curve = mine[0]!.curve;
  note("J09 authorized launch", "intent confirmed, token indexed", `launch-state=confirmed, token ${token}`, "local chain");
});

test("J10 bonding-curve trade is reflected after indexing; a transaction not yet mined changes nothing (indexer lag)", async ({ page, baseURL }) => {
  await page.goto(`/projects/${token}`);
  await expect(page.getByTestId("project-title")).toContainText("Journey Token");
  const buys = async () => ((await (await fetch(`${baseURL}/api/tokens/${token}`)).json()) as { token: { buy_count: number } }).token.buy_count;
  expect(await buys()).toBe(0);
  await rpc("evm_increaseTime", [30]); // clear the anti-snipe window
  await rpc("evm_mine");
  await rpc("evm_setAutomine", [false]);
  let hash: Hex;
  try {
    hash = await rpc<Hex>("eth_sendTransaction", [{ from: BUYER, to: curve, data: encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("10"), 0n, BUYER] }), value: `0x${parseEther("10").toString(16)}` }]);
    await new Promise((r) => setTimeout(r, 3_000)); // several worker passes while the tx is only pending
    expect(await buys(), "a pending (unmined) buy must not be indexed").toBe(0);
  } finally {
    await rpc("evm_setAutomine", [true]); // never leave the shared chain without automine
  }
  await rpc("evm_mine");
  const t0 = Date.now();
  await expect.poll(buys, { timeout: 60_000 }).toBe(1);
  const lagMs = Date.now() - t0;
  await page.reload();
  await expect(page.getByText(/1 buys/)).toBeVisible();
  await shot(page, "J10-after-first-trade");
  note("J10 trade + indexer lag", "UI/API reflect a buy only after it is mined and indexed", `pending tx ${hash.slice(0, 10)}… not indexed after 3s; indexed ${lagMs} ms after mining`, "local chain, embedded worker interval 1.5s");
});

test("J11-J13 graduation (sandbox pool), Explore discovery and token detail", async ({ page, baseURL }) => {
  await sendTx(BUYER, curve, encodeFunctionData({ abi: ponsV2BondingCurveAbi, functionName: "buy", args: [parseEther("25"), 0n, BUYER] }), parseEther("25"));
  const launched = (await rpc<Hex>("eth_call", [{ to: process.env.E2E_FACTORY, data: encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "getLaunchedToken", args: [token as Hex] }) }, "latest"])) as Hex;
  expect(launched.length).toBeGreaterThan(2);
  const phaseOf = async () => ((await (await fetch(`${baseURL}/api/tokens/${token}`)).json()) as { token: { phase: string } }).token.phase;
  await expect.poll(phaseOf, { timeout: 30_000 }).toMatch(/bonding_curve_active|graduation_initiated|graduated/);
  // the threshold-crossing buy normally auto-graduates; the permissionless graduate() is the canonical fallback
  // (WrongGraduationPhase 0x9465dbd4 = already graduated by the buy itself)
  await sendTx(BUYER, process.env.E2E_FACTORY!, encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "graduate", args: [token as Hex] })).catch((e: Error) => {
    if (!e.message.includes("0x9465dbd4")) throw e;
  });
  await expect.poll(phaseOf, { timeout: 60_000 }).toBe("graduation_initiated");
  await sendTx(BUYER, process.env.E2E_FACTORY!, encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "createGraduatedPool", args: [token as Hex] }));
  await expect.poll(phaseOf, { timeout: 60_000 }).toBe("graduated");
  await page.goto(`/projects/${token}`);
  await expect(page.getByText(/held by the launch locker/)).toBeVisible();
  await shot(page, "J11-graduated-token-detail");
  note("J11 graduation", "phase graduated, liquidity position locked", "project page shows 'V4 position … held by the launch locker'", "SANDBOX (mock) V4 pool; genuine Uniswap V4 graduation is evidenced by the test/v4 suite, not by this browser run");

  await page.goto("/");
  await expect(page.getByTestId("explore-table")).toContainText("Journey Token");
  await expect(page.getByTestId("explore-table")).toContainText("finco-labs/journey-main");
  await shot(page, "J12-explore");
  await page.getByTestId("explore-table").getByText("Journey Token").first().click();
  await expect(page.getByTestId("project-title")).toContainText("Journey Token");
  await expect(page.getByTestId("verified-badge")).toContainText("@carol-admin");
  await expect(page.getByTestId("proof-of-build")).toContainText("hash chain and signatures verified");
  await shot(page, "J13-token-detail");
  note("J12/J13 discovery + detail", "token listed with its repository and Proof of Build", "Explore row and detail page show Journey Token, finco-labs/journey-main, verified @carol-admin");
});

test("J14-J17 creator earnings, treasury allocation, prepare + send claim, canonical indexed claim event", async ({ page, baseURL }) => {
  // graduation (previous test) swept the curve fees into the canonical escrow; the worker then attests the protocol leg
  const headroomCall = encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", args: [NATIVE] });
  await expect
    .poll(async () => decodeFunctionResult({ abi: forgeProtocolRevenueSplitterAbi, functionName: "verifiedHeadroom", data: await rpc<Hex>("eth_call", [{ to: splitter, data: headroomCall }, "latest"]) }), { timeout: 60_000 })
    .toBeGreaterThan(0n);
  await sendTx(KEEPER, splitter, encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "pullRevenue", args: [NATIVE, 0n] }));

  await injectWallet(page, CREATOR);
  await page.goto("/dashboard");
  const gh = page.getByRole("link", { name: "Connect GitHub" });
  if (await gh.isVisible().catch(() => false)) {
    await gh.click();
    await page.waitForURL("**/launch");
    await page.goto("/dashboard");
  }
  await expect(page.getByTestId("creator-earnings")).toBeVisible();
  await expect(page.getByTestId("claimable-ETH")).not.toHaveText(/^0 ETH$/, { timeout: 30_000 });
  const claimable = (await page.getByTestId("claimable-ETH").innerText()).trim();
  await expect(page.getByTestId("reconciliation").first()).toContainText("reconciled");
  await shot(page, "J14-creator-earnings");

  // J16 incomplete claim: prepared but never sent => nothing is claimed, also after a refresh
  await page.getByTestId("prepare-claim-ETH").click();
  await expect(page.getByTestId("claim-preview")).toContainText("canonical escrow");
  await shot(page, "J16-claim-prepared");
  await page.reload();
  await expect(page.getByTestId("claimable-ETH")).toHaveText(claimable);
  note("J16 incomplete claim", "a prepared-but-unsent claim claims nothing", `claimable stays ${claimable} after refresh`);

  await page.getByTestId("prepare-claim-ETH").click();
  await expect(page.getByTestId("claim-preview")).toContainText("canonical escrow");
  const connect = page.getByTestId("claim-connect-wallet");
  const send = page.getByTestId("send-claim");
  await expect(connect.or(send.and(page.locator(":enabled")))).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId("claim-status").first()).toHaveText(/CONFIRMED_INDEXED/, { timeout: 60_000 });
  await expect(page.getByTestId("claimable-ETH")).toHaveText("0 ETH", { timeout: 30_000 });
  await shot(page, "J17-claim-confirmed-indexed");
  note("J16/J17 claim", "claim counted only after the canonical escrow claim event is indexed", `claim-status CONFIRMED_INDEXED; claimable ${claimable} -> 0 ETH`, "local chain");

  await page.goto("/treasury");
  await expect(page.getByTestId("treasury-overview")).toBeVisible();
  await expect(page.getByTestId("reserve-status")).toContainText("DISABLED");
  await expect(page.getByTestId("treasury-allocated-ETH")).not.toHaveText(/^0 ETH$/);
  await expect(page.getByTestId("reconciliation").first()).toContainText("reconciled");
  await shot(page, "J15-treasury-reserve-allocation");
  note("J15 treasury/reserve", "treasury and FINCO reserve allocations visible; burn disabled; reconciled", `reserve-status=${(await page.getByTestId("reserve-status").innerText()).replace(/\s+/g, " ").slice(0, 80)}`);
  void baseURL;
});

test("N01-N06 negative wallet/network/signature/transaction cases in the launch wizard", async ({ page }) => {
  await loginAs(1003);
  // wrong network: wallet reports chain 1 and refuses to switch
  await injectWallet(page, OTHER_WALLET, { chainIdHex: "0x1" });
  await page.goto("/launch");
  await page.getByTestId("connect-github").click().catch(() => undefined);
  await page.waitForURL("**/launch");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByText("wrong network", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Switch to chain/ }).click();
  await expect(page.getByTestId("error")).toContainText("declined in your wallet");
  await expect(page.getByTestId("error")).not.toContainText("viem");
  await shot(page, "N01-wrong-network");
  note("N01 wrong network", "wrong-network chip, switch refused by wallet, error shown, nothing signed", `error: ${(await page.getByTestId("error").innerText()).replace(/\s+/g, " ").slice(0, 120)}`);
});

test("N02-N04 wrong wallet, invalid signature, failed transaction, double submission", async ({ page, baseURL }) => {
  await loginAs(1003);
  // wrong wallet: bound wallet is CREATOR; connect a different account
  await injectWallet(page, CREATOR);
  await page.goto("/launch");
  await page.getByTestId("connect-github").click();
  await page.waitForURL("**/launch");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("bind-wallet").or(page.getByTestId("wallet-bound")).first()).toBeVisible();
  if (await page.getByTestId("bind-wallet").isVisible()) await page.getByTestId("bind-wallet").click();
  await expect(page.getByTestId("wallet-bound")).toContainText(CREATOR);
  const second = await page.context().newPage();
  await injectWallet(second, OTHER_WALLET);
  await second.goto("/launch");
  // wagmi reconnects the injected wallet on load; click only if it did not
  await second.waitForLoadState("networkidle");
  if (await second.getByTestId("connect-wallet").isVisible().catch(() => false)) await second.getByTestId("connect-wallet").click({ timeout: 5_000 }).catch(() => undefined);
  await expect(second.getByText(/differs from your bound wallet/)).toBeVisible();
  await shot(second, "N02-wrong-wallet");
  note("N02 wrong wallet", "connected account differs from bound wallet => warning, signing blocked", "alert 'The connected account differs from your bound wallet …'");
  await second.close();

  // invalid signature: the wallet returns a garbage EIP-712 signature
  await injectWallet(page, CREATOR, { badTypedDataSignature: true });
  await signInAndVerify(page, 5004, "journey-revoke");
  await configure(page, "Bad Sig", "BSIG");
  await page.getByTestId("authorize").click();
  await expect(page.getByTestId("authorization")).toContainText("epoch");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("error")).toContainText("BAD_SIGNATURE"); // the server's specific refusal, not any error
  await expect(page.getByTestId("launch")).toHaveCount(0);
  await shot(page, "N03-invalid-signature");
  note("N03 invalid signature", "server rejects the signature with BAD_SIGNATURE; launch never offered", `error: ${(await page.getByTestId("error").innerText()).replace(/\s+/g, " ").slice(0, 140)}`);
  void baseURL;
});

test("N05-N07 failed transaction, double submission and refresh/reconnect recovery on one repository", async ({ page, baseURL }) => {
  await loginAs(1003);
  await injectWallet(page, CREATOR, { failSendTransaction: true });
  await signInAndVerify(page, 5004, "journey-revoke");
  await configure(page, "Recover Token", "RCVR");
  await page.getByTestId("authorize").click();
  await expect(page.getByTestId("authorization")).toContainText("epoch");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("launch")).toBeVisible();
  await page.getByTestId("launch").click();
  await expect(page.getByTestId("error")).toContainText(/reverted|failed|simulated/i);
  await shot(page, "N05-failed-transaction");
  note("N05 failed transaction", "wallet/chain failure surfaces as an error; no token created", `error: ${(await page.getByTestId("error").innerText()).replace(/\s+/g, " ").slice(0, 120)}`);
  const count = async () => ((await (await fetch(`${baseURL}/api/tokens`)).json()) as { tokens: Array<{ creator: string }> }).tokens.filter((t) => t.creator.toLowerCase() === CREATOR.toLowerCase()).length;
  expect(await count(), "failed tx created nothing").toBe(1); // only the J09 token

  // refresh/reconnect: a fresh page with a working wallet recovers the same session and completes
  await page.close();
  const p2 = await page.context().newPage();
  await injectWallet(p2, CREATOR);
  await signInAndVerify(p2, 5004, "journey-revoke");
  note("N07 refresh/reconnect", "session and wallet binding survive a reload; wizard restartable", "account-status and wallet-bound visible again after a new page");
  await configure(p2, "Recover Token", "RCVR");
  await p2.getByTestId("authorize").click();
  await expect(p2.getByTestId("authorization")).toContainText("epoch");
  await p2.getByTestId("sign").click();
  // double submission: two rapid clicks must produce exactly one launch transaction
  await p2.getByTestId("launch").dblclick();
  await expect(p2.getByTestId("launch-state")).toHaveText("confirmed", { timeout: 60_000 });
  const sentTx = await p2.evaluate(() => (window as unknown as { __ethSendTxCount?: number }).__ethSendTxCount ?? 0);
  expect(sentTx, "the wallet received EXACTLY ONE transaction submission despite the double click").toBe(1);
  expect(await count(), "double click launched exactly one token").toBe(2);
  await shot(p2, "N06-double-submit-single-launch");
  note("N06 double submission", "double click => exactly one wallet transaction submission and one token", `eth_sendTransaction calls = ${sentTx}; creator has exactly 2 tokens (J09 + this one)`);
});

test("N08 stale repository proof: administration removed after verification => authorization refused", async ({ page, baseURL }) => {
  await loginAs(1003);
  await injectWallet(page, CREATOR);
  await signInAndVerify(page, 5005, "journey-stale");
  await configure(page, "Stale Proof", "STAL");
  // The prerequisite GitHub-side changes must actually succeed before the refusal can be attributed
  // to the stale proof (a silently failing control or webhook would make this test pass for nothing).
  const perm = await ghControl("set-permission", { repoId: 5005, userId: 1003, perm: "write" });
  expect(perm.status, "fake-GitHub control: downgrade to write").toBe(200);
  const wh = await webhook(baseURL!, "member", { action: "edited", repository: { id: 5005, full_name: "finco-labs/journey-stale" }, member: { id: 1003, login: "carol-admin" } });
  expect(wh.status, "signed member.edited webhook accepted").toBe(200);
  await page.getByTestId("authorize").click();
  await expect(page.getByTestId("error")).toContainText("NOT_ADMIN", { timeout: 30_000 }); // the specific refusal the doc reports
  await shot(page, "N08-stale-proof-refused");
  note("N08 stale proof", "authorization refused with NOT_ADMIN after administration is removed", `error: ${(await page.getByTestId("error").innerText()).replace(/\s+/g, " ").slice(0, 140)}`, "FakeGithub permission change + signed webhook");
});

test("J18-J19 repository authority revoked (transfer) => on-chain binding revoked and new authorization refused", async ({ page, baseURL }) => {
  await loginAs(1003);
  const isActive = async () =>
    decodeFunctionResult({ abi: forgeBindingRegistryAbi, functionName: "isActive", data: await rpc<Hex>("eth_call", [{ to: registry, data: encodeFunctionData({ abi: forgeBindingRegistryAbi, functionName: "isActive", args: [5003n, CREATOR] }) }, "latest"]) });
  expect(await isActive()).toBe(true);
  const newOwner = { id: 99_100, login: "new-owner", type: "Organization" };
  await ghControl("transfer", { repoId: 5003, owner: newOwner });
  const r = await webhook(baseURL!, "repository", { action: "transferred", repository: { id: 5003, full_name: "new-owner/journey-main", owner: newOwner } });
  expect(r.status).toBe(200);
  await expect.poll(isActive, { timeout: 90_000, intervals: [500] }).toBe(false);
  note("J18 revoke authority", "repository transfer revokes the on-chain binding via the worker", "registry.isActive(5003, creator) became false", "FakeGithub transfer + signed webhook; local chain");

  await injectWallet(page, CREATOR);
  await page.goto("/launch");
  await page.getByTestId("connect-github").click();
  await page.waitForURL("**/launch");
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("account-status")).toContainText("@carol-admin");
  await page.getByTestId("repo-5003").click({ timeout: 10_000 }).catch(() => undefined);
  await expect(page.getByTestId("eligibility-result")).toHaveCount(0);
  await shot(page, "J19-revoked-repo-refused");
  const draft = await page.evaluate(async () => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("forge_csrf="))?.split("=")[1] ?? "";
    const r = await fetch("/api/launch/drafts", { method: "POST", headers: { "content-type": "application/json", "x-forge-csrf": decodeURIComponent(csrf) }, body: JSON.stringify({ repoId: 5003, installationId: 7001, name: "Revoked", symbol: "RVKD", description: "should be refused", logo: "https://example.org/l.png", socials: {}, launchConfigId: 0, creatorTaxBps: 100, buybackEnabled: false, snipeTaxExemptions: [] }) });
    return { status: r.status, body: await r.text() };
  });
  expect(draft.status, "the revoked repository's verification is gone: draft refused with 403").toBe(403);
  expect(JSON.parse(draft.body).error?.code ?? draft.body, "refusal is specifically NOT_VERIFIED").toContain("NOT_VERIFIED");
  note("J19 refuse revoked authorization", "a launch draft for the revoked repository is refused with 403 NOT_VERIFIED", `HTTP ${draft.status}: ${draft.body.slice(0, 140)}`);
});

test("U01-U03 mobile viewport, keyboard accessibility and no horizontal overflow", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/", "/launch", "/treasury", "/dashboard", `/projects/${token}`]) {
    await page.goto(p);
    await expectNoHorizontalOverflow(page);
  }
  await shot(page, "U01-mobile-project");
  await page.goto("/launch");
  await shot(page, "U01-mobile-launch");
  // keyboard: Tab reaches the primary action and Enter activates it (signed-out launch page)
  await loginAs(1003);
  await page.context().clearCookies();
  await page.goto("/launch");
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "connect-github");
  }
  expect(reached, "Connect GitHub reachable by keyboard").toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/launch");
  await expect(page.getByTestId("account-status")).toContainText("@carol-admin");
  note("U01-U03 mobile + keyboard", "390px viewport has no horizontal overflow on 5 routes; the sign-in action is reachable and operable by keyboard alone", "verified");
  void baseURL;
});
