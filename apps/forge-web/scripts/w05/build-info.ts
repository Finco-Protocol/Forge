/**
 * W05 — exact build provenance for the Forge-owned artifacts: the profile as
 * written in foundry.toml and the settings solc itself recorded in each
 * artifact's metadata. Both are reported; a mismatch fails closed upstream.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { keccak256, type Hex } from "viem";
import { FORGE_OUT, REPO_ROOT } from "../artifacts";
import type { BuildSettings } from "./hook-mine-lib";

/** Minimal TOML reader: scalar `key = value` lines of one `[profile.X]` table. */
export function parseFoundryProfile(toml: string, profile: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let inside = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) {
      inside = t[1] === `profile.${profile}`;
      continue;
    }
    if (!inside) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const v = kv[2]!.trim();
    if (v === "true" || v === "false") out[kv[1]!] = v === "true";
    else if (/^-?\d+$/.test(v)) out[kv[1]!] = Number(v);
    else if (/^".*"$/.test(v)) out[kv[1]!] = v.slice(1, -1);
  }
  if (!Object.keys(out).length) throw new Error(`foundry.toml has no [profile.${profile}] scalars`);
  return out;
}

export function tomlBuildSettings(profile = "forge", tomlText?: string): BuildSettings {
  const p = parseFoundryProfile(tomlText ?? readFileSync(path.join(REPO_ROOT, "foundry.toml"), "utf8"), profile);
  return {
    solcVersion: String(p.solc),
    optimizer: p.optimizer === true,
    optimizerRuns: Number(p.optimizer_runs),
    viaIR: p.via_ir === true,
    evmVersion: String(p.evm_version),
    bytecodeHash: typeof p.bytecode_hash === "string" ? p.bytecode_hash : null,
  };
}

interface RawArtifact {
  bytecode: { object: Hex };
  deployedBytecode: { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> };
  metadata?: {
    compiler: { version: string };
    settings: { optimizer: { enabled: boolean; runs: number }; viaIR?: boolean; evmVersion: string; metadata?: { bytecodeHash?: string }; compilationTarget: Record<string, string> };
  };
}

export function readRawArtifact(file: string): RawArtifact {
  return JSON.parse(readFileSync(file, "utf8")) as RawArtifact;
}

export function artifactBuildSettings(a: RawArtifact): BuildSettings {
  if (!a.metadata) throw new Error("artifact has no solc metadata (cannot prove build settings)");
  const s = a.metadata.settings;
  return {
    solcVersion: a.metadata.compiler.version,
    optimizer: s.optimizer.enabled,
    optimizerRuns: s.optimizer.runs,
    viaIR: s.viaIR === true,
    evmVersion: s.evmVersion,
    bytecodeHash: s.metadata?.bytecodeHash ?? "ipfs",
  };
}

export function forgeArtifactPath(name: string, file = name): string {
  return path.join(FORGE_OUT, `${file}.sol`, `${name}.json`);
}

export interface ContractBuildRecord {
  contract: string;
  artifact: string;
  source: string;
  settings: BuildSettings;
  creationCodeKeccak: Hex;
  runtimeCodeKeccak: Hex;
  runtimeBytes: number;
}

export function contractBuildRecord(name: string): ContractBuildRecord {
  const p = forgeArtifactPath(name);
  const a = readRawArtifact(p);
  return {
    contract: name,
    artifact: path.relative(REPO_ROOT, p),
    source: Object.keys(a.metadata?.settings.compilationTarget ?? {})[0] ?? "unknown",
    settings: artifactBuildSettings(a),
    creationCodeKeccak: keccak256(a.bytecode.object),
    runtimeCodeKeccak: keccak256(a.deployedBytecode.object),
    runtimeBytes: (a.deployedBytecode.object.length - 2) / 2,
  };
}
