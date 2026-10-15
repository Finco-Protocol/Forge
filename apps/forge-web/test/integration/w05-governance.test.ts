/**
 * W05 governance simulation on a local Anvil with GENUINE published
 * artifacts: a Safe 1.5.0 (2-of-3) proposes/executes through an OpenZeppelin
 * TimelockController (2-day delay, self-administered) that takes ownership
 * of every Forge-owned contract via the contracts' real Ownable2Step
 * interfaces. Local dev chain only; no real ownership is transferred.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, http, keccak256, toHex, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploySandbox, ANVIL_KEYS, type SandboxDeployment } from "../../scripts/sandbox-lib";
import { forgeProtocolRevenueSplitterAbi, ponsV2LaunchFactoryAbi } from "@/shared/abis.generated";
import {
  batchId,
  checkGovernancePolicy,
  deployGovernance,
  executeBatchData,
  OWNED_CONTRACTS,
  ownableAbi,
  ownershipTransferBundle,
  safeAbi,
  safeExec,
  scheduleBatchData,
  timelockAbi,
  type Call,
  type OwnedContract,
} from "../../scripts/w05/governance";
import { startAnvil, rpc, type Anvil } from "../helpers/anvil";

const OWNER_KEYS = [ANVIL_KEYS[5], ANVIL_KEYS[6], ANVIL_KEYS[7]] as Hex[];
const RELAYER_KEY = ANVIL_KEYS[9] as Hex; // pays gas only; holds no authority
const DELAY = 2n * 24n * 3600n;

let anvil: Anvil;
let d: SandboxDeployment;
let pub: PublicClient;
let relayer: WalletClient;
let gov: { safe: Address; timelock: Address };
let owned: Record<OwnedContract, Address>;

const wallet = (key: Hex) => createWalletClient({ chain: defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } }), transport: http(anvil.url), account: privateKeyToAccount(key) });

async function warp(seconds: bigint) {
  await rpc(anvil.url, "evm_increaseTime", [Number(seconds)]);
  await rpc(anvil.url, "evm_mine");
}

async function governed(calls: Call[], saltLabel: string) {
  const salt = keccak256(toHex(saltLabel));
  await safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: scheduleBatchData(calls, salt, DELAY) }, OWNER_KEYS.slice(0, 2));
  return { salt, id: batchId(calls, salt) };
}

beforeAll(async () => {
  anvil = await startAnvil();
  d = await deploySandbox(anvil.url);
  pub = createPublicClient({ transport: http(anvil.url), pollingInterval: 100 }) as PublicClient;
  relayer = wallet(RELAYER_KEY);
  gov = await deployGovernance(pub, wallet(ANVIL_KEYS[0] as Hex), { owners: OWNER_KEYS.map((k) => privateKeyToAccount(k).address), threshold: 2, minDelay: DELAY });
  owned = { factory: d.factory, memeHook: d.memeHook, revenueSplitter: d.revenueSplitter, registry: d.registry, authorizer: d.authorizer, buybackVault: d.buybackVault, locker: d.locker };
}, 180_000);
afterAll(async () => anvil?.stop());

describe("W05 governance: Safe 2-of-3 → Timelock (2 days) owns the Forge stack", () => {
  it("the genuine Safe and Timelock are configured as required (roles, threshold, self-administered)", async () => {
    expect(await pub.readContract({ address: gov.safe, abi: safeAbi, functionName: "getThreshold" })).toBe(2n);
    expect((await pub.readContract({ address: gov.safe, abi: safeAbi, functionName: "getOwners" })).length).toBe(3);
    const role = (n: "PROPOSER_ROLE" | "EXECUTOR_ROLE" | "CANCELLER_ROLE" | "DEFAULT_ADMIN_ROLE") => pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: n });
    for (const r of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"] as const) {
      expect(await pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: "hasRole", args: [await role(r), gov.safe] })).toBe(true);
    }
    expect(await pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: "hasRole", args: [await role("DEFAULT_ADMIN_ROLE"), d.governance] })).toBe(false);
    expect(await pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: "getMinDelay" })).toBe(DELAY);
    expect(
      checkGovernancePolicy({ owners: OWNER_KEYS.map((k) => privateKeyToAccount(k).address), threshold: 2, timelockDelaySeconds: Number(DELAY), timelockAdmin: zeroAddress, forbiddenOwners: [d.treasury, d.authority, d.revenueAttestor] }),
    ).toEqual([]);
  });

  it("ownership hand-over: EOA transferOwnership → Safe-scheduled, timelock-executed acceptOwnership (all 7 contracts)", async () => {
    const { step1, step2 } = ownershipTransferBundle(owned, gov.timelock);
    const eoa = wallet(ANVIL_KEYS[0] as Hex);
    for (const c of step1) await pub.waitForTransactionReceipt({ hash: await eoa.sendTransaction({ to: c.target, data: c.data, chain: eoa.chain, account: eoa.account! }) });
    for (const k of OWNED_CONTRACTS) expect(await pub.readContract({ address: owned[k], abi: ownableAbi, functionName: "pendingOwner" })).toBe(gov.timelock);

    const { salt, id } = await governed(step2, "accept-ownership");
    // Not executable before the delay.
    await expect(safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(step2, salt) }, OWNER_KEYS.slice(0, 2))).rejects.toThrow();
    await warp(DELAY);
    expect(await pub.readContract({ address: gov.timelock, abi: timelockAbi, functionName: "isOperationReady", args: [id] })).toBe(true);
    await safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(step2, salt) }, [OWNER_KEYS[1]!, OWNER_KEYS[2]!]);
    for (const k of OWNED_CONTRACTS) expect(await pub.readContract({ address: owned[k], abi: ownableAbi, functionName: "owner" })).toBe(gov.timelock);
  });

  it("the former EOA owner and any single key are refused", async () => {
    const eoa = wallet(ANVIL_KEYS[0] as Hex);
    await expect(eoa.writeContract({ address: d.factory, abi: ponsV2LaunchFactoryAbi, functionName: "setLaunchFee", args: [1n], chain: eoa.chain, account: eoa.account! })).rejects.toThrow(/OwnableUnauthorizedAccount/);
    const ownerKey = wallet(OWNER_KEYS[0]!);
    await expect(ownerKey.writeContract({ address: d.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "setPullsPaused", args: [true], chain: ownerKey.chain, account: ownerKey.account! })).rejects.toThrow(/OwnableUnauthorizedAccount/);
    // The timelock itself cannot be driven directly by an owner key (no proposer role).
    const calls: Call[] = [{ target: d.factory, value: 0n, data: encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "setLaunchFee", args: [1n] }), label: "x" }];
    await expect(ownerKey.writeContract({ address: gov.timelock, abi: timelockAbi, functionName: "scheduleBatch", args: [calls.map((c) => c.target), [0n], calls.map((c) => c.data), toHex(0, { size: 32 }), keccak256(toHex("rogue")), DELAY], chain: ownerKey.chain, account: ownerKey.account! })).rejects.toThrow(/AccessControlUnauthorizedAccount/);
    // A Safe transaction with ONE signature (below threshold) is refused (GS020).
    await expect(safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: scheduleBatchData(calls, keccak256(toHex("one-sig")), DELAY) }, [OWNER_KEYS[0]!])).rejects.toThrow(/GS020/);
    // A schedule below the minimum delay is refused by the timelock.
    await expect(safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: scheduleBatchData(calls, keccak256(toHex("short")), DELAY - 1n) }, OWNER_KEYS.slice(0, 2))).rejects.toThrow();
  });

  it("propose → queue → cancel: a cancelled operation can never execute", async () => {
    const calls: Call[] = [{ target: d.factory, value: 0n, data: encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "setLaunchFee", args: [10n ** 18n] }), label: "factory.setLaunchFee(1 ETH)" }];
    const { salt, id } = await governed(calls, "fee-change-cancelled");
    await safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: encodeFunctionData({ abi: timelockAbi, functionName: "cancel", args: [id] }) }, OWNER_KEYS.slice(0, 2));
    await warp(DELAY);
    await expect(safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(calls, salt) }, OWNER_KEYS.slice(0, 2))).rejects.toThrow();
    expect(await pub.readContract({ address: d.factory, abi: ponsV2LaunchFactoryAbi, functionName: "launchFee" })).toBe(0n);
  });

  it("emergency pause is ALSO delayed under a timelock owner (disclosed): it takes effect only after the delay", async () => {
    const calls: Call[] = [{ target: d.revenueSplitter, value: 0n, data: encodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, functionName: "setPullsPaused", args: [true] }), label: "splitter.setPullsPaused(true)" }];
    const { salt } = await governed(calls, "emergency-pause");
    expect(await pub.readContract({ address: d.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "pullsPaused" })).toBe(false);
    await warp(DELAY);
    await safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: executeBatchData(calls, salt) }, OWNER_KEYS.slice(0, 2));
    expect(await pub.readContract({ address: d.revenueSplitter, abi: forgeProtocolRevenueSplitterAbi, functionName: "pullsPaused" })).toBe(true);
  });

  it("lost key recovery: the two remaining owners swap the lost owner out (Safe self-call) and revoke it", async () => {
    const owners = await pub.readContract({ address: gov.safe, abi: safeAbi, functionName: "getOwners" });
    const lost = privateKeyToAccount(OWNER_KEYS[2]!).address;
    const idx = owners.indexOf(lost);
    const prev = idx === 0 ? ("0x0000000000000000000000000000000000000001" as Address) : owners[idx - 1]!;
    const replacement = privateKeyToAccount(ANVIL_KEYS[8] as Hex).address;
    await safeExec(pub, relayer, gov.safe, { to: gov.safe, value: 0n, data: encodeFunctionData({ abi: safeAbi, functionName: "swapOwner", args: [prev, lost, replacement] }) }, OWNER_KEYS.slice(0, 2));
    const after = await pub.readContract({ address: gov.safe, abi: safeAbi, functionName: "getOwners" });
    expect(after).toContain(replacement);
    expect(after).not.toContain(lost);
    // The revoked key's signature no longer counts toward the threshold.
    const calls: Call[] = [{ target: d.factory, value: 0n, data: encodeFunctionData({ abi: ponsV2LaunchFactoryAbi, functionName: "setLaunchFee", args: [2n] }), label: "x" }];
    await expect(safeExec(pub, relayer, gov.safe, { to: gov.timelock, value: 0n, data: scheduleBatchData(calls, keccak256(toHex("revoked")), DELAY) }, [OWNER_KEYS[0]!, OWNER_KEYS[2]!])).rejects.toThrow(/GS026|GS020/);
  });

  it("policy floor refuses weak or role-overlapping governance configurations", () => {
    const owners = OWNER_KEYS.map((k) => privateKeyToAccount(k).address);
    expect(checkGovernancePolicy({ owners, threshold: 1, timelockDelaySeconds: Number(DELAY), timelockAdmin: zeroAddress, forbiddenOwners: [] }).join()).toMatch(/threshold/);
    expect(checkGovernancePolicy({ owners: owners.slice(0, 2), threshold: 2, timelockDelaySeconds: Number(DELAY), timelockAdmin: zeroAddress, forbiddenOwners: [] }).join()).toMatch(/at least 3 owners/);
    expect(checkGovernancePolicy({ owners, threshold: 2, timelockDelaySeconds: 3600, timelockAdmin: zeroAddress, forbiddenOwners: [] }).join()).toMatch(/delay/);
    expect(checkGovernancePolicy({ owners, threshold: 2, timelockDelaySeconds: Number(DELAY), timelockAdmin: owners[0]!, forbiddenOwners: [] }).join()).toMatch(/self-administered/);
    expect(checkGovernancePolicy({ owners, threshold: 2, timelockDelaySeconds: Number(DELAY), timelockAdmin: zeroAddress, forbiddenOwners: [owners[1]!] }).join()).toMatch(/role separation/);
  });
});
