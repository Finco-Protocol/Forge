/**
 * W05 — GENUINE Uniswap V4 artifacts (pinned devDependencies, never mocks):
 *   @uniswap/v4-core@1.0.2       out/PoolManager.sol/PoolManager.json, out/PoolSwapTest.sol/PoolSwapTest.json
 *   @uniswap/v4-periphery@1.0.3  foundry-out/PositionManager.sol, PositionDescriptor.sol, WETH.sol,
 *                                StateView.sol, DeployPermit2.sol (embeds the canonical Permit2 runtime)
 *
 * Also: Permit2 runtime extraction from DeployPermit2 and an immutable-aware
 * runtime comparison used against chain 4663 in fork mode.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { encodeAbiParameters, keccak256, pad, toHex, type Abi, type Address, type Hex } from "viem";

const require = createRequire(import.meta.url);

export interface GenuineArtifact {
  name: string;
  package: string;
  file: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
  compiler: string;
  optimizerRuns: number | null;
  viaIR: boolean;
  evmVersion: string;
}

const pkgDir = (pkg: string) => path.dirname(require.resolve(`${pkg}/package.json`));

export function packageVersion(pkg: string): string {
  return (JSON.parse(readFileSync(path.join(pkgDir(pkg), "package.json"), "utf8")) as { version: string }).version;
}

export function loadGenuine(pkg: "@uniswap/v4-core" | "@uniswap/v4-periphery", rel: string, name: string): GenuineArtifact {
  const file = path.join(pkgDir(pkg), rel);
  const j = JSON.parse(readFileSync(file, "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex; linkReferences?: Record<string, unknown> };
    deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
    metadata: { compiler: { version: string }; settings: { optimizer: { runs: number }; viaIR?: boolean; evmVersion: string } };
  };
  if (j.bytecode.linkReferences && Object.keys(j.bytecode.linkReferences).length) throw new Error(`${name} needs linking (unsupported)`);
  return {
    name,
    package: `${pkg}@${packageVersion(pkg)}`,
    file: `${pkg}/${rel}`,
    abi: j.abi,
    bytecode: j.bytecode.object,
    deployedBytecode: j.deployedBytecode.object,
    immutableReferences: j.deployedBytecode.immutableReferences ?? {},
    compiler: j.metadata.compiler.version,
    optimizerRuns: j.metadata.settings.optimizer?.runs ?? null,
    viaIR: j.metadata.settings.viaIR === true,
    evmVersion: j.metadata.settings.evmVersion,
  };
}

export const GENUINE = {
  poolManager: () => loadGenuine("@uniswap/v4-core", "out/PoolManager.sol/PoolManager.json", "PoolManager"),
  poolSwapTest: () => loadGenuine("@uniswap/v4-core", "out/PoolSwapTest.sol/PoolSwapTest.json", "PoolSwapTest"),
  positionManager: () => loadGenuine("@uniswap/v4-periphery", "foundry-out/PositionManager.sol/PositionManager.json", "PositionManager"),
  positionDescriptor: () => loadGenuine("@uniswap/v4-periphery", "foundry-out/PositionDescriptor.sol/PositionDescriptor.json", "PositionDescriptor"),
  weth: () => loadGenuine("@uniswap/v4-periphery", "foundry-out/WETH.sol/WETH.default.json", "WETH"),
  stateView: () => loadGenuine("@uniswap/v4-periphery", "foundry-out/StateView.sol/StateView.json", "StateView"),
  deployPermit2: () => loadGenuine("@uniswap/v4-periphery", "foundry-out/DeployPermit2.sol/DeployPermit2.json", "DeployPermit2"),
};

/** Canonical Permit2 address (identical on every chain it is deployed to). */
export const PERMIT2_CANONICAL: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/**
 * permit2/test/utils/DeployPermit2.sol (shipped compiled in v4-periphery)
 * `vm.etch`es the canonical Permit2 RUNTIME at PERMIT2_CANONICAL. The bytes
 * live in its own code as a memory literal copied with
 *   PUSH2 len  DUP2 MSTORE  PUSH1 0x20 ADD  PUSH2 off  PUSH2 len  DUP3 CODECOPY
 * (61 LLLL 81 52 60 20 01 61 OOOO 61 LLLL 91 39). We locate that pattern,
 * slice the literal, and sanity-check it (Permit2 ABI selectors present).
 * NOTE: this is RUNTIME code (with its constructor-time immutables already
 * baked in), not creation code — the same thing Uniswap's own tests use.
 */
export function permit2RuntimeFromDeployPermit2(a = GENUINE.deployPermit2()): { runtime: Hex; offset: number; length: number } {
  const code = a.deployedBytecode.slice(2).toLowerCase();
  const m = /61([0-9a-f]{4})815260200161([0-9a-f]{4})61([0-9a-f]{4})9139/.exec(code);
  if (!m) throw new Error("DeployPermit2: embedded Permit2 runtime literal not found");
  const len = parseInt(m[1]!, 16);
  const off = parseInt(m[2]!, 16);
  if (parseInt(m[3]!, 16) !== len) throw new Error("DeployPermit2: inconsistent literal length");
  const runtime = `0x${code.slice(off * 2, (off + len) * 2)}` as Hex;
  if ((runtime.length - 2) / 2 !== len) throw new Error("DeployPermit2: literal truncated");
  // Permit2 selectors: approve(address,address,uint160,uint48)=87517c45, DOMAIN_SEPARATOR()=3644e515.
  for (const sel of ["87517c45", "3644e515"]) if (!runtime.includes(sel)) throw new Error(`DeployPermit2: literal lacks Permit2 selector ${sel}`);
  if (!code.includes(PERMIT2_CANONICAL.slice(12).toLowerCase())) throw new Error("DeployPermit2: canonical Permit2 address not referenced");
  return { runtime, offset: off, length: len };
}

/** Permit2's EIP712: keccak256(abi.encode(TYPE_HASH, keccak256("Permit2"), chainId, address(this))). */
export function permit2DomainSeparator(chainId: number, permit2: Address = PERMIT2_CANONICAL): Hex {
  const typeHash = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"));
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }], [typeHash, keccak256(toHex("Permit2")), BigInt(chainId), permit2]),
  );
}

/**
 * Permit2's two immutables (_CACHED_CHAIN_ID, _CACHED_DOMAIN_SEPARATOR) as
 * baked into a runtime. Located structurally in DOMAIN_SEPARATOR():
 *   CHAINID PUSH32 <cachedChainId> SUB PUSH2 <jump> JUMPI PUSH32 <cachedDomainSeparator>
 * followed by the EIP712Domain TYPE_HASH literal. Offsets are of the 32-byte operands.
 */
export function permit2ImmutableLayout(runtime: Hex) {
  const c = runtime.slice(2).toLowerCase();
  const typeHash = keccak256(toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)")).slice(2);
  const re = /467f([0-9a-f]{64})0361[0-9a-f]{4}577f([0-9a-f]{64})/g;
  const hits: Array<{ chainIdOffset: number; domainSeparatorOffset: number; cachedChainId: number; cachedDomainSeparator: Hex }> = [];
  for (let m = re.exec(c); m; m = re.exec(c)) {
    if (m.index % 2) continue;
    const at = m.index / 2;
    hits.push({ chainIdOffset: at + 2, domainSeparatorOffset: at + 2 + 32 + 5 + 1, cachedChainId: Number(BigInt(`0x${m[1]}`)), cachedDomainSeparator: `0x${m[2]}` });
  }
  if (hits.length !== 1) throw new Error(`Permit2 runtime: expected exactly one DOMAIN_SEPARATOR immutable site, found ${hits.length}`);
  const h = hits[0]!;
  if (c.indexOf(typeHash, (h.domainSeparatorOffset + 32) * 2) < 0) throw new Error("Permit2 runtime: EIP712Domain TYPE_HASH not found after the immutable site");
  return { ...h, ranges: [{ start: h.chainIdOffset, length: 32 }, { start: h.domainSeparatorOffset, length: 32 }] };
}

/**
 * Re-binds the two constructor-time immutables to what Permit2's constructor
 * computes when it runs at `address` on `chainId` (block.chainid and
 * _buildDomainSeparator). Every other byte is the genuine runtime.
 */
export function rebindPermit2Immutables(runtime: Hex, chainId: number, address: Address = PERMIT2_CANONICAL): Hex {
  const l = permit2ImmutableLayout(runtime);
  const b = Buffer.from(runtime.slice(2), "hex");
  Buffer.from(pad(toHex(chainId), { size: 32 }).slice(2), "hex").copy(b, l.chainIdOffset);
  Buffer.from(permit2DomainSeparator(chainId, address).slice(2), "hex").copy(b, l.domainSeparatorOffset);
  return `0x${b.toString("hex")}`;
}

export interface CodeComparison {
  equalAfterMasking: boolean;
  localBytes: number;
  remoteBytes: number;
  maskedRanges: Array<{ start: number; length: number; local: Hex; remote: Hex }>;
  firstDiffOffset: number | null;
  localMaskedKeccak: Hex;
  remoteMaskedKeccak: Hex;
}

/** Compares two runtimes with the given immutable ranges zeroed in BOTH. */
export function compareRuntime(local: Hex, remote: Hex, ranges: Array<{ start: number; length: number }>): CodeComparison {
  const l = Buffer.from(local.slice(2), "hex");
  const r = Buffer.from(remote.slice(2), "hex");
  const maskedRanges = ranges.map((x) => ({
    start: x.start,
    length: x.length,
    local: `0x${l.subarray(x.start, x.start + x.length).toString("hex")}` as Hex,
    remote: `0x${r.subarray(x.start, x.start + x.length).toString("hex")}` as Hex,
  }));
  const lm = Buffer.from(l);
  const rm = Buffer.from(r);
  for (const x of ranges) {
    lm.fill(0, x.start, Math.min(x.start + x.length, lm.length));
    if (x.start < rm.length) rm.fill(0, x.start, Math.min(x.start + x.length, rm.length));
  }
  let firstDiff: number | null = null;
  const n = Math.max(lm.length, rm.length);
  for (let i = 0; i < n; i++)
    if (lm[i] !== rm[i]) {
      firstDiff = i;
      break;
    }
  return {
    equalAfterMasking: firstDiff === null,
    localBytes: l.length,
    remoteBytes: r.length,
    maskedRanges,
    firstDiffOffset: firstDiff,
    localMaskedKeccak: keccak256(lm),
    remoteMaskedKeccak: keccak256(rm),
  };
}

export function immutableRanges(a: GenuineArtifact) {
  return Object.values(a.immutableReferences).flat();
}
