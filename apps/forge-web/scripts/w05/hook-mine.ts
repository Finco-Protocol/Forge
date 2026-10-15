/**
 * W05 hook CREATE2 mining tool (offline, read-only: never sends a transaction).
 *
 *   pnpm w05:hook-mine --pool-manager 0x… --escrow 0x… --recipient 0x… --owner 0x… \
 *     [--deployer 0x4e59b44847b379578588920ca78fbf26c0b4956c] [--chain-id 4663] \
 *     [--salt 0x… (verify a chosen salt instead of mining)] [--out evidence.json]
 *
 * Reads the EXACT compiled PonsV2MemeHook from out/forge (`forge build
 * --profile forge`), cross-checks foundry.toml [profile.forge] against the
 * artifact's solc metadata, and prints JSON evidence. Exits non-zero (fail
 * closed) on a mask mismatch, a build-settings mismatch or missing inputs.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { REPO_ROOT } from "../artifacts";
import { artifactBuildSettings, forgeArtifactPath, readRawArtifact, tomlBuildSettings } from "./build-info";
import { buildHookEvidence, verifyHookEvidence, CREATE2_PROXY, type HookEvidence } from "./hook-mine-lib";

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`missing value for ${a}`);
    out[a.slice(2)] = v;
    i++;
  }
  return out;
}

function addr(args: Record<string, string>, k: string, fallback?: Address): Address {
  const v = args[k] ?? fallback;
  if (!v || !isAddress(v, { strict: false })) throw new Error(`--${k} must be an address`);
  return getAddress(v);
}

/** Computes (or verifies) hook evidence from the compiled artifact. */
export function hookEvidenceFromArtifact(args: Record<string, string>): HookEvidence {
  const p = forgeArtifactPath("PonsV2MemeHook");
  const a = readRawArtifact(p);
  return buildHookEvidence({
    chainIdTarget: Number(args["chain-id"] ?? 4663),
    artifact: path.relative(REPO_ROOT, p),
    creationCode: a.bytecode.object,
    args: { poolManager: addr(args, "pool-manager"), feeEscrow: addr(args, "escrow"), protocolFeeRecipient: addr(args, "recipient"), owner: addr(args, "owner") },
    deployer: addr(args, "deployer", CREATE2_PROXY),
    foundryProfile: "forge",
    toml: tomlBuildSettings("forge"),
    artifactMetadata: artifactBuildSettings(a),
    salt: args.salt as Hex | undefined,
  });
}

function main() {
  let ev: HookEvidence;
  try {
    ev = hookEvidenceFromArtifact(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`HOOK_MINE_FAILED: ${(e as Error).message}`);
    process.exit(2);
  }
  const failures = verifyHookEvidence(ev, readRawArtifact(forgeArtifactPath("PonsV2MemeHook")).bytecode.object);
  const json = JSON.stringify({ ...ev, failures }, null, 2);
  const out = parseArgs(process.argv.slice(2)).out;
  if (out) writeFileSync(out, json + "\n");
  console.log(json);
  if (failures.length) {
    console.error(`HOOK_MINE_REFUSED: ${failures.join("; ")}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
