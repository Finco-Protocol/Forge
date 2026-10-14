/**
 * Browser E2E over the production build: GitHub sign-in → wallet connect →
 * SIWE binding → repo verification → configure → economics → authorize →
 * EIP-712 signature → launch tx → indexed → project page → Explore.
 * The wallet is an EIP-1193 provider forwarding to Anvil's unlocked dev
 * account #5 (anvil signs personal_sign / eth_signTypedData_v4 / txs).
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CREATOR = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"; // anvil account #5
const SHOTS = path.resolve(process.cwd(), "test-results", "screens");
mkdirSync(SHOTS, { recursive: true });

async function injectWallet(page: Page, account: string) {
  await page.addInitScript(
    ({ rpc, account }) => {
      const listeners: Record<string, Array<(x: unknown) => void>> = {};
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
        on: (e: string, f: (x: unknown) => void) => ((listeners[e] ??= []).push(f), undefined),
        removeListener: (e: string, f: (x: unknown) => void) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
      };
    },
    { rpc: process.env.E2E_ANVIL_URL!, account },
  );
}

test("creator launches a verified token end-to-end in the browser", async ({ page }) => {
  await injectWallet(page, CREATOR);
  await page.goto("/launch");
  await expect(page.getByTestId("connect-github")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-connect.png`, fullPage: true });

  await page.getByTestId("connect-github").click();
  await page.waitForURL("**/launch");
  await expect(page.getByTestId("account-status")).toContainText("@alice-admin");

  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("bind-wallet").click();
  await expect(page.getByTestId("wallet-bound")).toContainText(CREATOR);

  await page.getByTestId("repo-5001").click();
  await expect(page.getByTestId("eligibility-result")).toContainText("finco-labs/forge-demo");
  await page.screenshot({ path: `${SHOTS}/02-verified.png`, fullPage: true });

  await page.getByTestId("to-configure").click();
  await page.getByTestId("f-name").fill("Forge Demo");
  await page.getByTestId("f-symbol").fill("FDEMO");
  await page.getByTestId("f-tax").fill("100");
  await page.screenshot({ path: `${SHOTS}/03-configure.png`, fullPage: true });
  await page.getByTestId("preview").click();
  await expect(page.getByTestId("economics")).toContainText("Graduation threshold");
  const predicted = (await page.getByTestId("predicted-token").textContent())!.trim();
  await page.screenshot({ path: `${SHOTS}/04-economics.png`, fullPage: true });

  await page.getByTestId("authorize").click();
  await expect(page.getByTestId("authorization")).toContainText("epoch 1");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("simulation")).toContainText(predicted);
  await page.screenshot({ path: `${SHOTS}/05-authorized.png`, fullPage: true });

  await page.getByTestId("launch").click();
  await expect(page.getByTestId("launch-state")).toHaveText("confirmed", { timeout: 60_000 });
  await page.screenshot({ path: `${SHOTS}/06-launched.png`, fullPage: true });

  await page.getByTestId("project-link").click();
  await expect(page.getByTestId("project-title")).toContainText("Forge Demo");
  await expect(page.getByTestId("verified-badge")).toContainText("@alice-admin");
  await expect(page.getByTestId("proof-of-build")).toContainText("hash chain and signatures verified");
  await expect(page.getByTestId("commit-sha")).toHaveText(/^[0-9a-f]{40}$/);
  await page.screenshot({ path: `${SHOTS}/07-project.png`, fullPage: true });

  await page.goto("/");
  await expect(page.getByTestId("explore-table")).toContainText("Forge Demo");
  await expect(page.getByTestId("explore-table")).toContainText("finco-labs/forge-demo");
  await page.screenshot({ path: `${SHOTS}/08-explore.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/09-explore-mobile.png`, fullPage: true });
  await page.goto("/dashboard");
  await expect(page.getByText("Creator dashboard")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-dashboard-mobile.png`, fullPage: true });
});

test("a non-admin GitHub user is refused in the UI with a clear reason", async ({ page }) => {
  await fetch(`${process.env.E2E_FAKE_GITHUB_URL}/__control/login-as`, { method: "POST", body: JSON.stringify({ userId: 1002 }) });
  await injectWallet(page, "0x976EA74026E726554dB657fA54763abd0C3a0aa9"); // anvil #6
  await page.goto("/launch");
  await page.getByTestId("connect-github").click();
  await page.waitForURL("**/launch");
  await expect(page.getByTestId("account-status")).toContainText("@bob-writer");
  await page.getByTestId("repo-5001").click();
  await expect(page.getByTestId("error")).toContainText("NOT_ADMIN");
  await page.screenshot({ path: `${SHOTS}/11-non-admin-refused.png`, fullPage: true });
});
