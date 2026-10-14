/**
 * W05 genuine-V4 lifecycle driver, shared by the local-genuine suite and the
 * fork suite. Drives the REAL Forge contracts directly (no app, no mocks):
 * every Uniswap leg is the genuine v4-core PoolManager, the genuine
 * v4-periphery PositionManager and the genuine Permit2 runtime. The only
 * test-only contract is Uniswap's OWN v4-core PoolSwapTest router.
 *
 * All transactions go to the local chain (fresh Anvil or a LOCAL Anvil fork).
 */
import {
  encodeAbiParameters,
  encodePacked,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import {
  forgeBindingRegistryAbi,
  forgeLaunchAuthorizerAbi,
  forgeProtocolRevenueSplitterAbi,
  ponsV2BondingCurveAbi,
  ponsV2FeeEscrowAbi,
  ponsV2LaunchFactoryAbi,
  ponsV2LaunchLockerAbi,
  ponsV2LauncherTokenAbi,
  ponsV2MemeHookAbi,
} from "@/shared/abis.generated";
import { ANVIL_KEYS, type SandboxDeployment } from "../../scripts/sandbox-lib";
import { clientsFor, type GenuineChain } from "../../scripts/w05/genuine-v4";
import { rpcCall } from "../../scripts/w05/anvil-proc";
import { GENUINE } from "../../scripts/w05/uniswap-artifacts";

export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const KEYS = {
  governance: ANVIL_KEYS[0],
  authority: ANVIL_KEYS[1],
  relayer: ANVIL_KEYS[2],
  attestor: ANVIL_KEYS[4],
  operator: ANVIL_KEYS[5],
  buyer: ANVIL_KEYS[6],
  stranger: ANVIL_KEYS[7],
  treasury: ANVIL_KEYS[8],
  creator: ANVIL_KEYS[9],
} as const;
const SOCIALS = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
export const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function totalSupply() view returns (uint256)"]);
const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const POSM = parseAbi(["function ownerOf(uint256) view returns (address)", "function getPositionLiquidity(uint256) view returns (uint128)", "function nextTokenId() view returns (uint256)"]);

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

export class Lifecycle {
  readonly url: string;
  readonly chainId: number;
  stateView!: Address;
  swapRouter!: Address;
  token!: Address;
  curve!: Address;
  key!: PoolKey;
  poolId!: Hex;
  positionId!: bigint;
  attestNonce = 0n;
  readonly creator: Address;
  readonly repoId = 4242n;

  constructor(
    readonly chain: GenuineChain,
    readonly d: SandboxDeployment,
  ) {
    this.url = chain.anvil.url;
    this.chainId = chain.v4.chainId;
    this.creator = this.c(KEYS.creator).account.address;
  }

  c(key: Hex) {
    return clientsFor(this.url, this.chainId, key);
  }
  get pub() {
    return this.c(KEYS.governance).pub;
  }

  async send(key: Hex, address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = [], value = 0n) {
    const { wallet, pub } = this.c(key);
    const hash = await wallet.writeContract({ address, abi, functionName, args, value } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted (tx ${hash})`);
    return r;
  }

  async read<T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []): Promise<T> {
    return (await this.pub.readContract({ address, abi, functionName, args } as never)) as T;
  }

  async fund() {
    for (const k of Object.values(KEYS)) await rpcCall(this.url, "anvil_setBalance", [this.c(k).account.address, "0x3635C9ADC5DEA00000"]);
  }

  /** Genuine helpers deployed on the local chain: StateView (lens) + Uniswap's own PoolSwapTest router. */
  async deployHelpers() {
    const { wallet, pub } = this.c(KEYS.buyer);
    const sv = GENUINE.stateView();
    const rt = GENUINE.poolSwapTest();
    const h1 = await wallet.deployContract({ abi: sv.abi, bytecode: sv.bytecode, args: [this.d.poolManager] } as never);
    this.stateView = (await pub.waitForTransactionReceipt({ hash: h1 })).contractAddress!;
    const h2 = await wallet.deployContract({ abi: rt.abi, bytecode: rt.bytecode, args: [this.d.poolManager] } as never);
    this.swapRouter = (await pub.waitForTransactionReceipt({ hash: h2 })).contractAddress!;
  }

  async bind() {
    const reg = this.d.registry;
    const now = (await this.pub.getBlock()).timestamp;
    const op = {
      githubRepoId: this.repoId,
      creator: this.creator,
      bindingExpiresAt: now + 30n * 86_400n,
      opDeadline: now + 300n,
      opNonce: (await this.read<bigint>(reg, forgeBindingRegistryAbi, "operationSequence", [this.repoId])) + 1n,
      parentOpDigest: await this.read<Hex>(reg, forgeBindingRegistryAbi, "headOpDigest", [this.repoId]),
      repoFullName: "finco/forge-w05-genuine-v4",
      revoke: false,
    };
    const digest = await this.read<Hex>(reg, forgeBindingRegistryAbi, "attestationDigestForBindingOp", [op]);
    const sig = await this.c(KEYS.authority).account.sign({ hash: digest });
    return this.send(KEYS.relayer, reg, forgeBindingRegistryAbi, "applyBindingOp", [op, sig]);
  }

  async launch(creatorTaxBps = 100) {
    const f = this.d.factory;
    const a = this.d.authorizer;
    const now = (await this.pub.getBlock()).timestamp;
    const meta = { name: "Forge Genuine V4", symbol: "FGV4", logo: "logo", description: "W05 genuine-V4 acceptance" };
    const tokenMetadataHash = keccak256(
      encodeAbiParameters(
        [
          { type: "string" },
          { type: "string" },
          { type: "string" },
          { type: "string" },
          { type: "tuple", components: ["twitter", "telegram", "discord", "website", "farcaster"].map((name) => ({ name, type: "string" })) },
        ],
        [meta.name, meta.symbol, meta.logo, meta.description, SOCIALS],
      ),
    );
    const economicsDigest = await this.read<Hex>(f, ponsV2LaunchFactoryAbi, "previewLaunchEconomics", [0n, NATIVE]);
    const intent = {
      factory: f,
      creator: this.creator,
      githubRepoId: this.repoId,
      launchConfigId: 0n,
      pairToken: NATIVE,
      tokenMetadataHash,
      economicsDigest,
      salt: keccak256(encodePacked(["string"], ["forge-w05-genuine-v4"])),
      expiresAt: now + 600n,
      nonce: 0n,
      creatorTaxBps,
      exemptionListHash: keccak256(encodeAbiParameters([{ type: "address[]" }], [[]])),
    };
    const consentDigest = await this.read<Hex>(a, forgeLaunchAuthorizerAbi, "consentDigest", [intent, this.creator, false]);
    const consent = await this.c(KEYS.creator).account.sign({ hash: consentDigest });
    const epoch = await this.read<bigint>(this.d.registry, forgeBindingRegistryAbi, "bindingEpoch", [this.repoId]);
    const attDigest = await this.read<Hex>(a, forgeLaunchAuthorizerAbi, "attestationDigest", [this.repoId, this.creator, epoch, now, now + 86_400n]);
    const att = await this.c(KEYS.authority).account.sign({ hash: attDigest });
    // abi.encodePacked(uint64 issuedAt, uint64 expiresAt, r, s, v)
    const attestationPayload = encodePacked(["uint64", "uint64", "bytes32", "bytes32", "uint8"], [now, now + 86_400n, `0x${att.slice(2, 66)}`, `0x${att.slice(66, 130)}`, parseInt(att.slice(130, 132), 16)]);
    const params = {
      ...meta,
      socials: SOCIALS,
      creatorFeeRecipient: NATIVE,
      creatorTaxBps,
      buybackEnabled: false,
      expectedEconomics: economicsDigest,
      salt: intent.salt,
      githubRepoId: this.repoId,
      authorizationExpiresAt: intent.expiresAt,
      authorizationNonce: intent.nonce,
      creatorSignature: consent,
      attestationPayload,
    };
    const r = await this.send(KEYS.creator, f, ponsV2LaunchFactoryAbi, "launchToken", [params, 0n, NATIVE]);
    const ev = parseEventLogs({ abi: ponsV2LaunchFactoryAbi, logs: r.logs, eventName: "TokenLaunched" })[0]!;
    this.token = getAddress(ev.args.token);
    this.curve = getAddress(ev.args.curve);
    this.key = { currency0: NATIVE, currency1: this.token, fee: Number(this.d.launchConfig.poolFee), tickSpacing: this.d.launchConfig.tickSpacing, hooks: this.d.memeHook };
    this.poolId = poolIdOf(this.key);
    // Step past the launch-second anti-snipe window (as the W04 economics suite does).
    await rpcCall(this.url, "evm_increaseTime", [20]);
    await rpcCall(this.url, "evm_mine");
    return r;
  }

  async buyOnCurve(eth: string) {
    const v = parseEther(eth);
    return this.send(KEYS.buyer, this.curve, ponsV2BondingCurveAbi, "buy", [v, 0n, this.c(KEYS.buyer).account.address], v);
  }

  async phase(): Promise<number> {
    const l = await this.read<{ phase: number }>(this.d.factory, ponsV2LaunchFactoryAbi, "getLaunchedToken", [this.token]);
    return Number(l.phase);
  }

  async graduateAndSeed() {
    if ((await this.phase()) === 0) await this.send(KEYS.stranger, this.d.factory, ponsV2LaunchFactoryAbi, "graduate", [this.token]);
    const r = await this.send(KEYS.stranger, this.d.factory, ponsV2LaunchFactoryAbi, "createGraduatedPool", [this.token]);
    this.positionId = await this.read<bigint>(this.d.locker, ponsV2LaunchLockerAbi, "lockedPositions", [this.token]);
    return r;
  }

  async poolState() {
    const [sqrtPriceX96, tick] = await this.read<[bigint, number, number, number]>(this.stateView, STATE_VIEW, "getSlot0", [this.poolId]);
    const liquidity = await this.read<bigint>(this.stateView, STATE_VIEW, "getLiquidity", [this.poolId]);
    const positionOwner = await this.read<Address>(this.d.positionManager, POSM, "ownerOf", [this.positionId]);
    const positionLiquidity = await this.read<bigint>(this.d.positionManager, POSM, "getPositionLiquidity", [this.positionId]);
    return { sqrtPriceX96, tick, liquidity, positionOwner: getAddress(positionOwner), positionLiquidity };
  }

  /** Exact-input swap through the GENUINE PoolManager via Uniswap's own PoolSwapTest. */
  async swap(key: Hex, zeroForOne: boolean, amountIn: bigint) {
    const router = GENUINE.poolSwapTest();
    if (!zeroForOne) await this.send(key, this.token, ERC20, "approve", [this.swapRouter, amountIn]);
    return this.send(
      key,
      this.swapRouter,
      router.abi,
      "swap",
      [this.key, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n }, { takeClaims: false, settleUsingBurn: false }, "0x"],
      zeroForOne ? amountIn : 0n,
    );
  }

  async pending(currency: Address) {
    const fee = await this.read<bigint>(this.d.memeHook, ponsV2MemeHookAbi, "pendingFees", [this.poolId, currency]);
    const tax = await this.read<bigint>(this.d.memeHook, ponsV2MemeHookAbi, "pendingCreatorTax", [this.poolId, currency]);
    return { fee, tax };
  }

  async escrowBalance(who: Address) {
    return this.read<bigint>(this.d.feeEscrow, ponsV2FeeEscrowAbi, "balanceOf", [who]);
  }

  /**
   * Test-side model of the off-chain attestor (as ForgeRevenueLifecycle.t.sol
   * `_attestEligible`): cumulative escrow Credited(splitter, depositor) where
   * the depositor is THIS launch's Forge curve or the Forge hook, from block
   * `fromBlock` to the evidence block.
   */
  async eligibleNativeCredits(fromBlock: bigint, toBlock: bigint): Promise<bigint> {
    const logs = await this.pub.getContractEvents({ address: this.d.feeEscrow, abi: ponsV2FeeEscrowAbi, eventName: "Credited", fromBlock, toBlock });
    const eligible = new Set([getAddress(this.curve), getAddress(this.d.memeHook)]);
    let sum = 0n;
    for (const l of logs) {
      const a = l.args as { recipient: Address; depositor: Address; amount: bigint };
      if (getAddress(a.recipient) === getAddress(this.d.revenueSplitter) && eligible.has(getAddress(a.depositor))) sum += a.amount;
    }
    return sum;
  }

  /** Signs and relays an EligibleRevenue ceiling (sandbox attestor key ANVIL_KEYS[4]). */
  async attest(cumulativeEligible: bigint) {
    await rpcCall(this.url, "evm_mine");
    const head = await this.pub.getBlock();
    const evidence = await this.pub.getBlock({ blockNumber: head.number - 1n });
    this.attestNonce += 1n;
    const auth = {
      escrow: this.d.feeEscrow,
      factory: this.d.factory,
      asset: NATIVE,
      cumulativeEligible,
      nonce: this.attestNonce,
      deadline: head.timestamp + 600n,
      evidenceBlock: evidence.number,
      evidenceBlockHash: evidence.hash,
    };
    const digest = hashTypedData({
      domain: { name: "FINCO Forge Revenue Splitter", version: "1", chainId: this.chainId, verifyingContract: this.d.revenueSplitter },
      types: {
        EligibleRevenue: [
          { name: "escrow", type: "address" },
          { name: "factory", type: "address" },
          { name: "asset", type: "address" },
          { name: "cumulativeEligible", type: "uint256" },
          { name: "nonce", type: "uint64" },
          { name: "deadline", type: "uint64" },
          { name: "evidenceBlock", type: "uint64" },
          { name: "evidenceBlockHash", type: "bytes32" },
        ],
      },
      primaryType: "EligibleRevenue",
      message: auth,
    });
    const onchain = await this.read<Hex>(this.d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "eligibleRevenueDigest", [auth]);
    if (onchain !== digest) throw new Error(`EligibleRevenue digest mismatch: local ${digest} vs splitter ${onchain}`);
    const signature = await this.c(KEYS.attestor).account.sign({ hash: digest });
    return this.send(KEYS.stranger, this.d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "authorizeEligibleRevenue", [auth, signature]);
  }

  async ledger() {
    return this.read<{
      revenueReceived: bigint;
      treasuryAllocated: bigint;
      reserveAllocated: bigint;
      treasuryPaid: bigint;
      nonRevenueReceived: bigint;
      nonRevenueReleased: bigint;
      eligibleCeiling: bigint;
      escrowClaimed: bigint;
    }>(this.d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "ledger", [NATIVE]);
  }

  async reconcile() {
    const [balance, accounted, surplus, deficit] = await this.read<[bigint, bigint, bigint, bigint]>(this.d.revenueSplitter, forgeProtocolRevenueSplitterAbi, "reconcile", [NATIVE]);
    return { balance, accounted, surplus, deficit };
  }

  async tokenBalance(who: Address) {
    return this.read<bigint>(this.token, ponsV2LauncherTokenAbi, "balanceOf", [who]);
  }
}
