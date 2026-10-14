/**
 * W05 governance tooling: Safe (multisig) + OpenZeppelin TimelockController
 * ownership of the Forge-owned stack. Builds the exact transaction bundles
 * an operator would review; deploys the GENUINE published artifacts
 * (@safe-global/safe-smart-account 1.5.0, @openzeppelin/contracts 5.6.1)
 * only to LOCAL dev chains for simulation. It never transfers real ownership.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  serializeSignature,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { sign } from "viem/accounts";

const NM = path.resolve(import.meta.dirname, "..", "..", "node_modules");

interface HardhatArtifact {
  abi: Abi;
  bytecode: Hex;
}
function artifact(rel: string): HardhatArtifact {
  const j = JSON.parse(readFileSync(path.join(NM, rel), "utf8")) as { abi: Abi; bytecode: Hex | { object: Hex } };
  const bytecode = typeof j.bytecode === "string" ? j.bytecode : (`0x${j.bytecode.object.replace(/^0x/, "")}` as Hex);
  return { abi: j.abi, bytecode };
}

export const GENUINE = {
  safe: () => artifact("@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json"),
  safeProxyFactory: () => artifact("@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json"),
  timelock: () => artifact("@openzeppelin/contracts/build/contracts/TimelockController.json"),
};

/** Every Forge-owned contract whose owner the governance arrangement takes over. */
export const OWNED_CONTRACTS = ["factory", "memeHook", "revenueSplitter", "registry", "authorizer", "buybackVault", "locker"] as const;
export type OwnedContract = (typeof OWNED_CONTRACTS)[number];

export const ownableAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address)",
  "function acceptOwnership()",
]);

export const timelockAbi = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) pure returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error TimelockInsufficientDelay(uint256 delay, uint256 minDelay)",
  "error TimelockUnexpectedOperationState(bytes32 operationId, bytes32 expectedStates)",
]);

export const safeAbi = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function changeThreshold(uint256 _threshold)",
]);

export const safeProxyFactoryAbi = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);

/** Policy floor for a production governance Safe (operator evidence must meet it; Class B). */
export const GOVERNANCE_POLICY = {
  minOwners: 3,
  minThreshold: 2,
  /** threshold must be a strict majority and never 1 */
  requireMajority: true,
  minTimelockDelaySeconds: 2 * 24 * 3600,
  /** the timelock must have no admin (self-administered) */
  timelockAdminMustBeZero: true,
} as const;

export interface GovernanceConfigEvidence {
  owners: Address[];
  threshold: number;
  timelockDelaySeconds: number;
  timelockAdmin: Address;
  /** addresses that must NOT be Safe owners (server signer roles, treasury recipient) */
  forbiddenOwners: Address[];
}

/** Validates an operator-supplied governance configuration against the policy floor. */
export function checkGovernancePolicy(e: GovernanceConfigEvidence): string[] {
  const errs: string[] = [];
  const owners = e.owners.map((o) => getAddress(o));
  if (new Set(owners).size !== owners.length) errs.push("duplicate Safe owners");
  if (owners.length < GOVERNANCE_POLICY.minOwners) errs.push(`Safe needs at least ${GOVERNANCE_POLICY.minOwners} owners`);
  if (e.threshold < GOVERNANCE_POLICY.minThreshold) errs.push(`threshold must be >= ${GOVERNANCE_POLICY.minThreshold}`);
  if (GOVERNANCE_POLICY.requireMajority && e.threshold * 2 <= owners.length) errs.push("threshold must be a strict majority of owners");
  if (e.threshold > owners.length) errs.push("threshold exceeds owner count");
  if (e.timelockDelaySeconds < GOVERNANCE_POLICY.minTimelockDelaySeconds) errs.push(`timelock delay must be >= ${GOVERNANCE_POLICY.minTimelockDelaySeconds}s`);
  if (GOVERNANCE_POLICY.timelockAdminMustBeZero && getAddress(e.timelockAdmin) !== zeroAddress) errs.push("timelock must be self-administered (admin = address(0))");
  for (const f of e.forbiddenOwners) if (owners.includes(getAddress(f))) errs.push(`role separation: ${getAddress(f)} must not be a governance Safe owner`);
  return errs;
}

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
  label: string;
}

/**
 * Ownership hand-over plan. Step 1 is sent by the CURRENT owner (EOA);
 * step 2 must be executed BY the timelock (scheduled by the Safe, delayed).
 */
export function ownershipTransferBundle(addresses: Record<OwnedContract, Address>, timelock: Address) {
  const step1: Call[] = OWNED_CONTRACTS.map((k) => ({
    target: addresses[k],
    value: 0n,
    data: encodeFunctionData({ abi: ownableAbi, functionName: "transferOwnership", args: [timelock] }),
    label: `${k}.transferOwnership(timelock)`,
  }));
  const step2: Call[] = OWNED_CONTRACTS.map((k) => ({
    target: addresses[k],
    value: 0n,
    data: encodeFunctionData({ abi: ownableAbi, functionName: "acceptOwnership" }),
    label: `${k}.acceptOwnership() [executed by timelock]`,
  }));
  return { step1, step2 };
}

export const SAFE_OP_CALL = 0;

/** Safe transaction hash + sorted owner signatures (raw ECDSA over the hash, v = 27/28). */
export async function safeSignatures(pub: PublicClient, safe: Address, tx: { to: Address; value: bigint; data: Hex }, ownerKeys: Hex[]) {
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const hash = await pub.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [tx.to, tx.value, tx.data, SAFE_OP_CALL, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
  });
  const { privateKeyToAccount } = await import("viem/accounts");
  const signed = await Promise.all(
    ownerKeys.map(async (k) => ({ owner: privateKeyToAccount(k).address, sig: serializeSignature(await sign({ hash, privateKey: k })) })),
  );
  signed.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  return { hash, nonce, signatures: concat(signed.map((s) => s.sig)) };
}

export async function safeExec(pub: PublicClient, relayer: WalletClient, safe: Address, tx: { to: Address; value: bigint; data: Hex }, ownerKeys: Hex[]) {
  const { signatures } = await safeSignatures(pub, safe, tx, ownerKeys);
  const hash = await relayer.writeContract({
    address: safe,
    abi: safeAbi,
    functionName: "execTransaction",
    args: [tx.to, tx.value, tx.data, SAFE_OP_CALL, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures],
    chain: relayer.chain,
    account: relayer.account!,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Safe execTransaction reverted (${hash})`);
  return hash;
}

export function scheduleBatchData(calls: Call[], salt: Hex, delay: bigint) {
  return encodeFunctionData({
    abi: timelockAbi,
    functionName: "scheduleBatch",
    args: [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), toHex(0, { size: 32 }), salt, delay],
  });
}
export function executeBatchData(calls: Call[], salt: Hex) {
  return encodeFunctionData({
    abi: timelockAbi,
    functionName: "executeBatch",
    args: [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), toHex(0, { size: 32 }), salt],
  });
}
export function batchId(calls: Call[], salt: Hex) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }, { type: "bytes[]" }, { type: "bytes32" }, { type: "bytes32" }],
      [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), toHex(0, { size: 32 }), salt],
    ),
  );
}

/** Deploys a genuine Safe (proxy) and a genuine TimelockController on a LOCAL dev chain. */
export async function deployGovernance(
  pub: PublicClient,
  deployer: WalletClient,
  opts: { owners: Address[]; threshold: number; minDelay: bigint },
) {
  const chainId = await pub.getChainId();
  if (chainId !== 31337 && chainId !== 1337) throw new Error(`refusing governance simulation on chain ${chainId} (local dev chains only)`);
  const deploy = async (a: HardhatArtifact, args: unknown[] = []) => {
    const hash = await deployer.deployContract({ abi: a.abi, bytecode: a.bytecode, args, chain: deployer.chain, account: deployer.account! });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress || r.status !== "success") throw new Error("deploy failed");
    return r.contractAddress;
  };
  const singleton = await deploy(GENUINE.safe());
  const proxyFactory = await deploy(GENUINE.safeProxyFactory());
  const initializer = encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [opts.owners, BigInt(opts.threshold), zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  const { result: safe, request } = await pub.simulateContract({
    address: proxyFactory,
    abi: safeProxyFactoryAbi,
    functionName: "createProxyWithNonce",
    args: [singleton, initializer, 0n],
    account: deployer.account!,
  });
  const r = await pub.waitForTransactionReceipt({ hash: await deployer.writeContract(request) });
  if (r.status !== "success") throw new Error("Safe proxy creation failed");
  // Proposer/executor = the Safe only; admin = address(0): self-administered timelock.
  const timelock = await deploy(GENUINE.timelock(), [opts.minDelay, [safe], [safe], zeroAddress]);
  return { singleton: getAddress(singleton), proxyFactory: getAddress(proxyFactory), safe: getAddress(safe), timelock: getAddress(timelock) };
}
