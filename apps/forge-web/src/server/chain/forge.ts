/**
 * Typed reads against the W02 Forge-owned contracts. Every economics figure
 * shown to a creator comes from here (the factory's own storage), and the
 * economics digest is recomputed locally and required to equal the
 * factory's previewLaunchEconomics — source parity, fail-closed.
 */
import { getAddress, type Address, type Hex } from "viem";
import {
  forgeBindingRegistryAbi,
  forgeLaunchAuthorizerAbi,
  ponsV2LaunchDeployerAbi,
  ponsV2LaunchFactoryAbi,
  ponsV2MemeHookAbi,
  ponsV2LaunchLockerAbi,
} from "@/shared/abis.generated";
import { economicsDigest, ZERO_ADDRESS, type TokenMetadata } from "@/shared/forge-typed-data";
import type { ForgeAddresses } from "../config";
import type { ForgePublicClient } from "./clients";
import { ForgeError } from "../errors";

export interface RegistryState {
  binding: {
    exists: boolean;
    creator: Address;
    boundBy: Address;
    boundAt: bigint;
    expiresAt: bigint;
    revokedAt: bigint;
    epoch: bigint;
    repoFullName: string;
  };
  opSequence: bigint;
  headOpDigest: Hex;
  bindingEpoch: bigint;
  authority: Address;
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export async function readRegistryState(client: ForgePublicClient, a: ForgeAddresses, repoId: bigint): Promise<RegistryState> {
  const block = await client.getBlock({ blockTag: "latest" });
  const opts = { blockNumber: block.number } as const;
  const [b, log, authority] = await Promise.all([
    client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "bindings", args: [repoId], ...opts }),
    client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "repoLogs", args: [repoId], ...opts }),
    client.readContract({ address: a.registry, abi: forgeBindingRegistryAbi, functionName: "eligibilityAuthority", ...opts }),
  ]);
  const [githubRepoId, creator, boundBy, boundAt, expiresAt, revokedAt, epoch, repoFullName] = b;
  const [opSequence, bindingEpoch, headOpDigest] = log;
  return {
    binding: { exists: githubRepoId !== 0n, creator, boundBy, boundAt, expiresAt, revokedAt, epoch, repoFullName },
    opSequence,
    headOpDigest,
    bindingEpoch,
    authority,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
  };
}

export function bindingActiveFor(s: RegistryState, creator: Address): boolean {
  return s.binding.exists && s.binding.revokedAt === 0n && getAddress(s.binding.creator) === getAddress(creator) && s.binding.expiresAt >= s.blockTimestamp;
}

export interface EconomicsSnapshot {
  launchConfigId: string;
  pairToken: Address;
  digest: Hex;
  supply: string;
  curveFeeBps: string;
  phantomQuote: string;
  graduationThreshold: string;
  poolFee: number;
  tickSpacing: number;
  configEnabled: boolean;
  protocolFeeRecipient: Address;
  protocolFeeShareBps: number;
  buybackBurnBps: number;
  hookFeeBps: number;
  maxInternalPriceImpactBps: number;
  maxCreatorTaxBps: string;
  snipeTaxStartBps: string;
  snipeTaxSeconds: string;
  launchFeeWei: string;
  launchEnabled: boolean;
  pairApproved: boolean;
  pairDecimals: number;
  factoryOwner: Address;
  hookOwner: Address;
  launchAuthorizer: Address;
  readAtBlock: string;
  readAtTimestamp: string;
}

export async function readEconomics(client: ForgePublicClient, a: ForgeAddresses, launchConfigId: bigint, pairToken: Address): Promise<EconomicsSnapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const at = { blockNumber: block.number } as const;
  const f = { address: a.factory, abi: ponsV2LaunchFactoryAbi } as const;
  const count = await client.readContract({ ...f, functionName: "launchConfigCount", ...at });
  if (launchConfigId >= count) throw new ForgeError("INVALID_LAUNCH_CONFIG", `Launch configuration ${launchConfigId} does not exist.`);
  const [config, policy, digest, maxCreatorTaxBps, snipeTaxStartBps, snipeTaxSeconds, launchFee, launchEnabled, factoryOwner, hookOwner, authorizer] =
    await Promise.all([
      client.readContract({ ...f, functionName: "getLaunchConfig", args: [launchConfigId], ...at }),
      client.readContract({ address: a.memeHook, abi: ponsV2MemeHookAbi, functionName: "currentFeePolicy", ...at }),
      client.readContract({ ...f, functionName: "previewLaunchEconomics", args: [launchConfigId, pairToken], ...at }),
      client.readContract({ ...f, functionName: "maxCreatorTaxBps", ...at }),
      client.readContract({ ...f, functionName: "snipeTaxStartBps", ...at }),
      client.readContract({ ...f, functionName: "snipeTaxSeconds", ...at }),
      client.readContract({ ...f, functionName: "launchFee", ...at }),
      client.readContract({ ...f, functionName: "launchEnabled", ...at }),
      client.readContract({ ...f, functionName: "owner", ...at }),
      client.readContract({ address: a.memeHook, abi: ponsV2MemeHookAbi, functionName: "owner", ...at }),
      client.readContract({ ...f, functionName: "launchAuthorizer", ...at }),
    ]);
  let phantomQuote = config.phantomQuote;
  let graduationThreshold = config.graduationThreshold;
  let pairApproved = true;
  let pairDecimals = 18;
  if (pairToken !== ZERO_ADDRESS) {
    const [approved, pe] = await Promise.all([
      client.readContract({ ...f, functionName: "approvedPairTokens", args: [pairToken], ...at }),
      client.readContract({ ...f, functionName: "pairTokenEconomics", args: [pairToken], ...at }),
    ]);
    pairApproved = approved;
    [phantomQuote, graduationThreshold, pairDecimals] = pe;
  }
  const local = economicsDigest({
    phantomQuote,
    graduationThreshold,
    supply: config.supply,
    curveFeeBps: config.curveFeeBps,
    poolFee: config.poolFee,
    tickSpacing: config.tickSpacing,
    protocolFeeShareBps: policy.protocolFeeShareBps,
    buybackBurnBps: policy.buybackBurnBps,
    hookFeeBps: policy.hookFeeBps,
    maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
  });
  if (local !== digest) {
    throw new ForgeError("ECONOMICS_PARITY_FAILED", "Locally decoded economics do not reproduce the factory's digest; refusing to display them.", 500);
  }
  return {
    launchConfigId: launchConfigId.toString(),
    pairToken,
    digest,
    supply: config.supply.toString(),
    curveFeeBps: config.curveFeeBps.toString(),
    phantomQuote: phantomQuote.toString(),
    graduationThreshold: graduationThreshold.toString(),
    poolFee: config.poolFee,
    tickSpacing: config.tickSpacing,
    configEnabled: config.enabled,
    protocolFeeRecipient: policy.protocolFeeRecipient,
    protocolFeeShareBps: policy.protocolFeeShareBps,
    buybackBurnBps: policy.buybackBurnBps,
    hookFeeBps: policy.hookFeeBps,
    maxInternalPriceImpactBps: policy.maxInternalPriceImpactBps,
    maxCreatorTaxBps: maxCreatorTaxBps.toString(),
    snipeTaxStartBps: snipeTaxStartBps.toString(),
    snipeTaxSeconds: snipeTaxSeconds.toString(),
    launchFeeWei: launchFee.toString(),
    launchEnabled,
    pairApproved,
    pairDecimals,
    factoryOwner,
    hookOwner,
    launchAuthorizer: authorizer,
    readAtBlock: block.number.toString(),
    readAtTimestamp: block.timestamp.toString(),
  };
}

export interface LaunchOptions extends TokenMetadata {
  creatorFeeRecipient: Address; // effective (creator when unset)
  creatorTaxBps: number;
  buybackEnabled: boolean;
  salt: Hex;
}

/** CREATE2 address preview through the deployer's own predict path (same code the launch uses). */
export async function predictLaunchAddresses(
  client: ForgePublicClient,
  a: ForgeAddresses,
  e: EconomicsSnapshot,
  creator: Address,
  o: LaunchOptions,
): Promise<{ token: Address; curve: Address }> {
  const f = { address: a.factory, abi: ponsV2LaunchFactoryAbi } as const;
  const [feeEscrow, buybackVault] = await Promise.all([
    client.readContract({ ...f, functionName: "feeEscrow" }),
    client.readContract({ ...f, functionName: "buybackVault" }),
  ]);
  const [token, curve] = await client.readContract({
    address: a.launchDeployer,
    abi: ponsV2LaunchDeployerAbi,
    functionName: "predictLaunchAddresses",
    args: [
      {
        pairToken: e.pairToken,
        creatorFeeRecipient: o.creatorFeeRecipient,
        originalDeployer: creator,
        feePolicy: a.memeHook,
        policy: {
          protocolFeeRecipient: e.protocolFeeRecipient,
          protocolFeeShareBps: e.protocolFeeShareBps,
          buybackBurnBps: e.buybackBurnBps,
          hookFeeBps: e.hookFeeBps,
          maxInternalPriceImpactBps: e.maxInternalPriceImpactBps,
        },
        feeEscrow,
        buybackVault,
        phantomQuote: BigInt(e.phantomQuote),
        curveFeeBps: BigInt(e.curveFeeBps),
        creatorTaxBps: BigInt(o.creatorTaxBps),
        buybackEnabled: o.buybackEnabled,
        graduationThreshold: BigInt(e.graduationThreshold),
        supply: BigInt(e.supply),
        salt: o.salt,
        name: o.name,
        symbol: o.symbol,
        logo: o.logo,
        description: o.description,
        socials: o.socials,
      },
    ],
  });
  return { token, curve };
}

export async function readCreatorNonce(client: ForgePublicClient, a: ForgeAddresses, creator: Address): Promise<bigint> {
  return client.readContract({ address: a.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "nextCreatorNonce", args: [creator] });
}

export async function readLaunchedToken(client: ForgePublicClient, a: ForgeAddresses, token: Address, blockNumber?: bigint) {
  return client.readContract({
    address: a.factory,
    abi: ponsV2LaunchFactoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
    ...(blockNumber !== undefined ? { blockNumber } : {}),
  });
}

export async function readLockState(client: ForgePublicClient, a: ForgeAddresses, token: Address) {
  const [locked, positionId] = await Promise.all([
    client.readContract({ address: a.locker, abi: ponsV2LaunchLockerAbi, functionName: "isLocked", args: [token] }),
    client.readContract({ address: a.locker, abi: ponsV2LaunchLockerAbi, functionName: "lockedPositions", args: [token] }),
  ]);
  return { locked, positionId };
}
