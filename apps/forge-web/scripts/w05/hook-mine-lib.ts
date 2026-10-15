/**
 * W05 — deterministic CREATE2 salt mining for PonsV2MemeHook.
 *
 * Uniswap V4 encodes a hook's permissions in the low 14 bits of its address
 * (Hooks.validateHookPermissions, called from BaseHook's constructor). The
 * Forge hook declares beforeInitialize | afterSwap | afterSwapReturnDelta, so
 * its address must satisfy `address & 0x3fff == 0x2044` EXACTLY (any extra
 * permission bit is also a revert, HookAddressNotValid).
 *
 * The search is deterministic: salts are tried from 0 upward, so the same
 * (deployer, init-code hash) always yields the same salt. Pure functions only
 * here (no filesystem, no network) so the unit project can test them without
 * `forge build`; artifact/toml loading lives in hook-mine.ts / build-info.ts.
 */
import { bytesToHex, concat, encodeAbiParameters, getAddress, hexToBytes, keccak256, numberToHex, type Address, type Hex } from "viem";

/** beforeInitialize (1<<13) | afterSwap (1<<6) | afterSwapReturnDelta (1<<2). */
export const HOOK_FLAGS = 0x2044n;
/** Hooks.ALL_HOOK_MASK: the 14 permission bits. */
export const ALL_HOOK_MASK = 0x3fffn;
/** Arachnid's deterministic-deployment proxy (CREATE2 factory: calldata = salt ‖ initCode). */
export const CREATE2_PROXY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
/** Default search bound (2^24): the expected work for a 14-bit match is ~2^14. */
export const DEFAULT_MAX_ITERATIONS = 1n << 24n;

export interface HookCtorArgs {
  poolManager: Address;
  feeEscrow: Address;
  protocolFeeRecipient: Address;
  owner: Address;
}

/** Init code exactly as `type(PonsV2MemeHook).creationCode ‖ abi.encode(poolManager, escrow, recipient, owner)`. */
export function hookInitCode(creationCode: Hex, a: HookCtorArgs): Hex {
  return concat([
    creationCode,
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }], [a.poolManager, a.feeEscrow, a.protocolFeeRecipient, a.owner]),
  ]);
}

export function hookPermissionBits(addr: Address): bigint {
  return BigInt(addr) & ALL_HOOK_MASK;
}

export function hookMaskOk(addr: Address, flags: bigint = HOOK_FLAGS): boolean {
  return hookPermissionBits(addr) === flags;
}

export function create2Address(deployer: Address, salt: Hex, initCodeHash: Hex): Address {
  const h = keccak256(concat(["0xff", deployer, salt, initCodeHash]));
  return getAddress(`0x${h.slice(26)}`);
}

export interface MineResult {
  salt: Hex;
  saltIndex: bigint;
  address: Address;
  iterations: bigint;
}

/**
 * Deterministic search from salt 0 upward. Throws (never returns a
 * non-matching salt) when the bound is exhausted.
 */
export function mineHookSalt(deployer: Address, initCodeHash: Hex, opts: { flags?: bigint; start?: bigint; maxIterations?: bigint } = {}): MineResult {
  const flags = opts.flags ?? HOOK_FLAGS;
  if ((flags & ~ALL_HOOK_MASK) !== 0n) throw new Error(`flags 0x${flags.toString(16)} exceed the 14-bit hook mask`);
  const start = opts.start ?? 0n;
  const max = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // 0xff ‖ deployer(20) ‖ salt(32) ‖ initCodeHash(32): mutate the salt bytes in place.
  const buf = new Uint8Array(85);
  buf[0] = 0xff;
  buf.set(hexToBytes(getAddress(deployer)), 1);
  buf.set(hexToBytes(initCodeHash), 53);
  const view = new DataView(buf.buffer);
  for (let i = 0n; i < max; i++) {
    const s = start + i;
    // salt = uint256 big-endian in buf[21..53): write the four 64-bit limbs directly (hot loop).
    view.setBigUint64(21, (s >> 192n) & 0xffffffffffffffffn);
    view.setBigUint64(29, (s >> 128n) & 0xffffffffffffffffn);
    view.setBigUint64(37, (s >> 64n) & 0xffffffffffffffffn);
    view.setBigUint64(45, s & 0xffffffffffffffffn);
    const h = keccak256(buf, "bytes");
    // Low 14 bits of the address = low 14 bits of the hash's last two bytes.
    const low = (BigInt(h[30]!) << 8n) | BigInt(h[31]!);
    if ((low & ALL_HOOK_MASK) === flags) {
      const salt = numberToHex(s, { size: 32 });
      return { salt, saltIndex: s, address: getAddress(bytesToHex(h.slice(12))), iterations: i + 1n };
    }
  }
  throw new Error(`HOOK_MINE_EXHAUSTED: no salt in [${start}, ${start + max}) gives mask 0x${flags.toString(16)}`);
}

export interface BuildSettings {
  solcVersion: string;
  optimizer: boolean;
  optimizerRuns: number;
  viaIR: boolean;
  evmVersion: string;
  bytecodeHash: string | null;
}

export interface HookEvidence {
  kind: "FORGE_HOOK_CREATE2_EVIDENCE";
  version: 1;
  chainIdTarget: number;
  contract: "PonsV2MemeHook";
  artifact: string;
  build: { foundryProfile: string; toml: BuildSettings; artifactMetadata: BuildSettings; consistent: boolean };
  creationCodeKeccak: Hex;
  constructorArgs: HookCtorArgs;
  initCodeHash: Hex;
  deployer: Address;
  deployerNote: string;
  salt: Hex;
  saltIndex: string;
  iterations: string;
  computedAddress: Address;
  requiredFlags: string;
  permissionBits: string;
  maskOk: boolean;
}

/** Compares the profile in foundry.toml with the artifact's own solc metadata. */
export function buildSettingsMismatches(toml: BuildSettings, meta: BuildSettings): string[] {
  const out: string[] = [];
  if (!meta.solcVersion.startsWith(toml.solcVersion)) out.push(`solc ${meta.solcVersion} ≠ toml ${toml.solcVersion}`);
  if (meta.optimizer !== toml.optimizer) out.push(`optimizer ${meta.optimizer} ≠ toml ${toml.optimizer}`);
  if (meta.optimizerRuns !== toml.optimizerRuns) out.push(`runs ${meta.optimizerRuns} ≠ toml ${toml.optimizerRuns}`);
  if (meta.viaIR !== toml.viaIR) out.push(`via_ir ${meta.viaIR} ≠ toml ${toml.viaIR}`);
  if (meta.evmVersion !== toml.evmVersion) out.push(`evm ${meta.evmVersion} ≠ toml ${toml.evmVersion}`);
  if (toml.bytecodeHash && meta.bytecodeHash && toml.bytecodeHash !== meta.bytecodeHash) out.push(`bytecode_hash ${meta.bytecodeHash} ≠ toml ${toml.bytecodeHash}`);
  return out;
}

export function buildHookEvidence(input: {
  chainIdTarget: number;
  artifact: string;
  creationCode: Hex;
  args: HookCtorArgs;
  deployer?: Address;
  foundryProfile: string;
  toml: BuildSettings;
  artifactMetadata: BuildSettings;
  /** Verify a pre-chosen salt instead of mining one. */
  salt?: Hex;
  maxIterations?: bigint;
}): HookEvidence {
  const deployer = getAddress(input.deployer ?? CREATE2_PROXY);
  const initCode = hookInitCode(input.creationCode, input.args);
  const initCodeHash = keccak256(initCode);
  let r: MineResult;
  if (input.salt) {
    const address = create2Address(deployer, input.salt, initCodeHash);
    r = { salt: input.salt, saltIndex: BigInt(input.salt), address, iterations: 0n };
  } else {
    r = mineHookSalt(deployer, initCodeHash, { maxIterations: input.maxIterations });
  }
  const mism = buildSettingsMismatches(input.toml, input.artifactMetadata);
  return {
    kind: "FORGE_HOOK_CREATE2_EVIDENCE",
    version: 1,
    chainIdTarget: input.chainIdTarget,
    contract: "PonsV2MemeHook",
    artifact: input.artifact,
    build: { foundryProfile: input.foundryProfile, toml: input.toml, artifactMetadata: input.artifactMetadata, consistent: mism.length === 0 },
    creationCodeKeccak: keccak256(input.creationCode),
    constructorArgs: {
      poolManager: getAddress(input.args.poolManager),
      feeEscrow: getAddress(input.args.feeEscrow),
      protocolFeeRecipient: getAddress(input.args.protocolFeeRecipient),
      owner: getAddress(input.args.owner),
    },
    initCodeHash,
    deployer,
    deployerNote:
      deployer === getAddress(CREATE2_PROXY)
        ? "Deterministic-deployment proxy (0x4e59…956c). Its presence and runtime on the target chain MUST be verified read-only (eth_getCode) before use; on 4663 this is CI-only (the RPC is unreachable from the dev container)."
        : "Custom CREATE2 deployer: the computed address is only valid for this exact deployer contract.",
    salt: r.salt,
    saltIndex: r.saltIndex.toString(),
    iterations: r.iterations.toString(),
    computedAddress: r.address,
    requiredFlags: `0x${HOOK_FLAGS.toString(16)}`,
    permissionBits: `0x${hookPermissionBits(r.address).toString(16)}`,
    maskOk: hookMaskOk(r.address),
  };
}

/**
 * Re-derives everything in an evidence record; returns the list of failures
 * (empty = valid). Fail-closed callers exit non-zero on any entry.
 */
export function verifyHookEvidence(e: HookEvidence, creationCode?: Hex): string[] {
  const out: string[] = [];
  if (creationCode && keccak256(creationCode) !== e.creationCodeKeccak) out.push("creation code differs from the evidence (artifact changed: re-mine)");
  if (creationCode) {
    const ih = keccak256(hookInitCode(creationCode, e.constructorArgs));
    if (ih !== e.initCodeHash) out.push("init-code hash differs from the evidence");
  }
  const addr = create2Address(e.deployer, e.salt, e.initCodeHash);
  if (addr !== e.computedAddress) out.push(`computed address ${addr} ≠ evidence ${e.computedAddress}`);
  if (!hookMaskOk(addr)) out.push(`HOOK_MASK_MISMATCH: ${addr} has permission bits 0x${hookPermissionBits(addr).toString(16)}, required 0x2044`);
  if (!e.build.consistent) out.push("build settings in foundry.toml and artifact metadata disagree");
  return out;
}
