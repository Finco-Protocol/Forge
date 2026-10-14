import { ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import { reviveLaunchArgs, reviveTypedData, type LaunchTxJson } from "@/shared/launch-tx";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { chainClients, TestBrowser, type Sandbox } from "./sandbox";

export const ORG = { id: 9001, login: "finco-labs", type: "Organization" };
export const ALICE = { id: 1001, login: "alice-admin" };
export const BOB = { id: 1002, login: "bob-writer" };
export const REPO_ID = 5001;
export const INSTALLATION_ID = 7001;

/** Alice administers finco-labs/forge-demo; the Forge App is installed on finco-labs covering it; Bob has write. */
export function seedGithub(sb: Sandbox) {
  const gh = sb.github;
  gh.addUser(ALICE.id, ALICE.login);
  gh.addUser(BOB.id, BOB.login);
  const repo = gh.addRepo({ id: REPO_ID, name: "forge-demo", owner: ORG });
  gh.setPermission(REPO_ID, ALICE.id, "admin");
  gh.setPermission(REPO_ID, BOB.id, "write");
  gh.install(INSTALLATION_ID, ORG, [REPO_ID]);
  return repo;
}

export const DRAFT = {
  repoId: REPO_ID,
  installationId: INSTALLATION_ID,
  name: "Forge Demo",
  symbol: "FDEMO",
  description: "Verified builder token for finco-labs/forge-demo (sandbox).",
  logo: "https://example.org/logo.png",
  socials: { website: "https://example.org" },
  launchConfigId: 0,
  creatorTaxBps: 100,
  buybackEnabled: false,
  snipeTaxExemptions: [] as string[],
};

/** Runs the full creator flow up to (and including) a mined launch transaction. */
export async function launchThroughApi(sb: Sandbox, browser: TestBrowser, creatorKey: Hex, draftOverrides: Record<string, unknown> = {}) {
  const draft = await browser.post("/api/launch/drafts", { ...DRAFT, ...draftOverrides });
  if (draft.status !== 201) throw new Error(`draft: ${JSON.stringify(draft.json)}`);
  const auth = await browser.post(`/api/launch/drafts/${draft.json.id}/authorize`);
  if (auth.status !== 200) throw new Error(`authorize: ${JSON.stringify(auth.json)}`);
  const account = privateKeyToAccount(creatorKey);
  const signature = await account.signTypedData(reviveTypedData(auth.json.typedData));
  const signed = await browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature });
  if (signed.status !== 200) throw new Error(`signature: ${JSON.stringify(signed.json)}`);
  const { wallet, pub } = chainClients(sb.anvil.url, creatorKey);
  const a = reviveLaunchArgs(signed.json.tx as LaunchTxJson);
  const txHash = await wallet.writeContract({
    address: (signed.json.tx as LaunchTxJson).address,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "launchToken",
    args: [a.params, a.launchConfigId, a.pairToken, a.exemptions],
    value: a.value,
  });
  await pub.waitForTransactionReceipt({ hash: txHash });
  const submitted = await browser.post(`/api/launch/intents/${auth.json.intentId}/submitted`, { txHash });
  return { draft, auth, signed, txHash, submitted };
}

// ── fresh, isolated scenarios (one user / org / repo / installation / wallet each) ──
import { generatePrivateKey } from "viem/accounts";
import { rpc } from "./anvil";
import { forgeLaunchAuthorizerAbi, forgeBindingRegistryAbi } from "@/shared/abis.generated";
import type { Abi } from "viem";

let counter = 0;

export async function freshCreator(sb: Sandbox): Promise<Hex> {
  const key = generatePrivateKey();
  await rpc(sb.anvil.url, "anvil_setBalance", [privateKeyToAccount(key).address, "0x3635C9ADC5DEA00000"]);
  return key;
}

export async function freshScenario(sb: Sandbox, opts: { verify?: boolean; bind?: boolean } = {}) {
  const n = ++counter;
  const user = { id: 20_000 + n, login: `builder-${n}` };
  const org = { id: 80_000 + n, login: `org-${n}`, type: "Organization" };
  const repoId = 60_000 + n;
  const installationId = 71_000 + n;
  sb.github.addUser(user.id, user.login);
  sb.github.addRepo({ id: repoId, name: `project-${n}`, owner: org });
  sb.github.setPermission(repoId, user.id, "admin");
  sb.github.install(installationId, org, [repoId]);
  const browser = new TestBrowser(sb);
  await browser.signInGithub(user.id);
  const key = await freshCreator(sb);
  if (opts.bind !== false) {
    const b = await browser.bindWallet(key);
    if (b.status !== 200) throw new Error(`bind: ${JSON.stringify(b.json)}`);
  }
  if (opts.verify !== false) {
    const v = await browser.post("/api/github/verify", { repoId, installationId });
    if (v.status !== 200) throw new Error(`verify: ${JSON.stringify(v.json)}`);
  }
  return {
    n,
    user,
    org,
    repoId,
    installationId,
    browser,
    key,
    address: privateKeyToAccount(key).address,
    draft: { ...DRAFT, repoId, installationId, symbol: `T${n}` },
  };
}

/** Authorizes + signs through the API, returning the exact launch call without sending it. */
export async function signedLaunch(sb: Sandbox, browser: TestBrowser, key: Hex, draft: Record<string, unknown>) {
  const d = await browser.post("/api/launch/drafts", draft);
  if (d.status !== 201) throw new Error(`draft: ${JSON.stringify(d.json)}`);
  const auth = await browser.post(`/api/launch/drafts/${d.json.id}/authorize`);
  if (auth.status !== 200) throw new Error(`authorize: ${JSON.stringify(auth.json)}`);
  const signature = await privateKeyToAccount(key).signTypedData(reviveTypedData(auth.json.typedData));
  const signed = await browser.post(`/api/launch/intents/${auth.json.intentId}/signature`, { signature });
  if (signed.status !== 200) throw new Error(`signature: ${JSON.stringify(signed.json)}`);
  return { draft: d, auth, signature, signed, call: reviveLaunchArgs(signed.json.tx as LaunchTxJson) };
}

/** Factory + authorizer + registry errors, so bubbled reverts decode by name. */
export const LAUNCH_ERRORS_ABI = [
  ...ponsV2LaunchFactoryAbi,
  ...forgeLaunchAuthorizerAbi.filter((x) => x.type === "error"),
  ...forgeBindingRegistryAbi.filter((x) => x.type === "error"),
] as unknown as Abi;

export async function simulateLaunch(sb: Sandbox, key: Hex, call: ReturnType<typeof reviveLaunchArgs>): Promise<string> {
  const { pub, account } = chainClients(sb.anvil.url, key);
  try {
    await pub.simulateContract({
      account,
      address: sb.deployment.factory,
      abi: LAUNCH_ERRORS_ABI,
      functionName: "launchToken",
      args: [call.params, call.launchConfigId, call.pairToken, call.exemptions],
      value: call.value,
    });
    return "OK";
  } catch (e) {
    const err = e as { cause?: { data?: { errorName?: string } }; shortMessage?: string };
    return err.cause?.data?.errorName ?? err.shortMessage ?? String(e);
  }
}

export async function governanceWrite(sb: Sandbox, address: Hex, abi: Abi, functionName: string, args: unknown[]) {
  const { wallet, pub } = chainClients(sb.anvil.url, "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const h = await wallet.writeContract({ address, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
}
