import { readFileSync } from "node:fs";
import path from "node:path";
import type { Abi, Hex } from "viem";

/** Repository root (apps/forge-web/../..). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
/** Output of `forge build --profile forge` (the W02 Forge-owned stack). */
export const FORGE_OUT = path.join(REPO_ROOT, "out", "forge");

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function loadArtifact(file: string, name = file): Artifact {
  const p = path.join(FORGE_OUT, `${file}.sol`, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    throw new Error(`Missing W02 artifact ${p}. Run \`forge build --profile forge\` at the repository root first.`);
  }
  const json = JSON.parse(raw) as { abi: Abi; bytecode: { object: Hex } };
  if (json.bytecode.object.includes("__$")) throw new Error(`${name} needs library linking (unsupported)`);
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export function loadDeployedSize(file: string, name = file): number {
  const p = path.join(FORGE_OUT, `${file}.sol`, `${name}.json`);
  const json = JSON.parse(readFileSync(p, "utf8")) as { deployedBytecode: { object: Hex } };
  return (json.deployedBytecode.object.length - 2) / 2;
}
