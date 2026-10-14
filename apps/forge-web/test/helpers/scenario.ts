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
