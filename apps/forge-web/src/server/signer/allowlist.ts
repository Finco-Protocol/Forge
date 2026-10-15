/**
 * Per-role signing allowlist: the ONLY payloads each custody role may sign.
 * Domains are pinned to this deployment's chain id and contract addresses,
 * and struct definitions to the canonical types the contracts hash, so a
 * request with a look-alike type or a foreign domain is refused before any
 * digest is computed for custody.
 */
import { getAddress, type Address } from "viem";
import { bindingOpTypes, eligibilityAttestationTypes, LAUNCH_EIP712_NAME, LAUNCH_EIP712_VERSION, REGISTRY_EIP712_NAME, REGISTRY_EIP712_VERSION } from "@/shared/forge-typed-data";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN } from "../finance/attestor";
import type { ForgeAddresses } from "../config";

export type SignerRole = "authority" | "evidence" | "revenue";
export const SIGNER_ROLES: readonly SignerRole[] = ["authority", "evidence", "revenue"];

export type TypedFields = readonly { readonly name: string; readonly type: string }[];
export type CanonicalTypes = Readonly<Record<string, TypedFields>>;

export interface Eip712Rule {
  kind: "eip712";
  primaryType: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: CanonicalTypes;
}
/** EIP-191 personal message over exactly one 32-byte hash (Proof-of-Build receipts). */
export interface Eip191Hash32Rule {
  kind: "eip191-hash32";
}
export type AllowRule = Eip712Rule | Eip191Hash32Rule;

export function buildAllowlist(role: SignerRole, d: { chainId: number; addresses: Pick<ForgeAddresses, "registry" | "authorizer" | "revenueSplitter"> }): AllowRule[] {
  switch (role) {
    case "authority":
      return [
        {
          kind: "eip712",
          primaryType: "BindingOp",
          domain: { name: REGISTRY_EIP712_NAME, version: REGISTRY_EIP712_VERSION, chainId: d.chainId, verifyingContract: getAddress(d.addresses.registry) },
          types: bindingOpTypes,
        },
        {
          kind: "eip712",
          primaryType: "EligibilityAttestation",
          domain: { name: LAUNCH_EIP712_NAME, version: LAUNCH_EIP712_VERSION, chainId: d.chainId, verifyingContract: getAddress(d.addresses.authorizer) },
          types: eligibilityAttestationTypes,
        },
      ];
    case "revenue":
      return d.addresses.revenueSplitter
        ? [
            {
              kind: "eip712",
              primaryType: "EligibleRevenue",
              domain: { ...SPLITTER_EIP712_DOMAIN, chainId: d.chainId, verifyingContract: getAddress(d.addresses.revenueSplitter) },
              types: ELIGIBLE_REVENUE_TYPES,
            },
          ]
        : [];
    case "evidence":
      return [{ kind: "eip191-hash32" }];
  }
}

/** Exact structural equality of struct definitions (names, field order, field types). */
export function sameTypes(a: Readonly<Record<string, TypedFields>>, b: CanonicalTypes): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  for (const k of kb) {
    const fa = a[k]!;
    const fb = b[k]!;
    if (!Array.isArray(fa) || fa.length !== fb.length) return false;
    for (let i = 0; i < fb.length; i++) {
      const x = fa[i] as { name?: unknown; type?: unknown };
      if (Object.keys(x).length !== 2 || x.name !== fb[i]!.name || x.type !== fb[i]!.type) return false;
    }
  }
  return true;
}
