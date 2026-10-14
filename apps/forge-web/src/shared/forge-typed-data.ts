/**
 * EIP-712 domains, types and hashing helpers that MUST match the W02
 * contracts byte for byte:
 *   - ForgeBindingRegistry   EIP712("FINCO Forge Binding Registry", "2")
 *   - ForgeLaunchAuthorizer  EIP712("FINCO Forge Launch", "1")
 *   - PonsV2LaunchFactory    tokenMetadataHash / canonical exemption hash /
 *                            economics digest preimages
 * Isomorphic: used by the server (authority signing, verification) and the
 * browser (creator signature request). Integration tests cross-check every
 * digest against the contracts' own view functions on a live chain.
 */
import { encodeAbiParameters, encodePacked, keccak256, getAddress, isAddress, type Address, type Hex } from "viem";

export const REGISTRY_EIP712_NAME = "FINCO Forge Binding Registry";
export const REGISTRY_EIP712_VERSION = "2";
export const LAUNCH_EIP712_NAME = "FINCO Forge Launch";
export const LAUNCH_EIP712_VERSION = "1";

/** ForgeBindingRegistry.MAX_OP_VALIDITY / MAX_BINDING_HORIZON. */
export const MAX_OP_VALIDITY_SECONDS = 10 * 60;
export const MAX_BINDING_HORIZON_SECONDS = 30 * 24 * 60 * 60;
/** ForgeLaunchAuthorizer.MAX_ATTESTATION_AGE. */
export const MAX_ATTESTATION_AGE_SECONDS = 3 * 24 * 60 * 60;
/** PonsV2LaunchFactory.MAX_SNIPE_TAX_EXEMPTIONS. */
export const MAX_SNIPE_TAX_EXEMPTIONS = 32;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export function registryDomain(chainId: number, registry: Address) {
  return { name: REGISTRY_EIP712_NAME, version: REGISTRY_EIP712_VERSION, chainId, verifyingContract: registry } as const;
}

export function launchDomain(chainId: number, authorizer: Address) {
  return { name: LAUNCH_EIP712_NAME, version: LAUNCH_EIP712_VERSION, chainId, verifyingContract: authorizer } as const;
}

export const bindingOpTypes = {
  BindingOp: [
    { name: "githubRepoId", type: "uint64" },
    { name: "creator", type: "address" },
    { name: "bindingExpiresAt", type: "uint64" },
    { name: "opDeadline", type: "uint64" },
    { name: "opNonce", type: "uint64" },
    { name: "parentOpDigest", type: "bytes32" },
    { name: "repoFullName", type: "string" },
    { name: "revoke", type: "bool" },
  ],
} as const;

export const launchAuthorizationTypes = {
  LaunchAuthorization: [
    { name: "factory", type: "address" },
    { name: "creator", type: "address" },
    { name: "githubRepoId", type: "uint64" },
    { name: "launchConfigId", type: "uint256" },
    { name: "pairToken", type: "address" },
    { name: "tokenMetadataHash", type: "bytes32" },
    { name: "economicsDigest", type: "bytes32" },
    { name: "salt", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "creatorTaxBps", type: "uint16" },
    { name: "exemptionListHash", type: "bytes32" },
  ],
} as const;

export const eligibilityAttestationTypes = {
  EligibilityAttestation: [
    { name: "githubRepoId", type: "uint64" },
    { name: "creator", type: "address" },
    { name: "bindingEpoch", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export interface BindingOp {
  githubRepoId: bigint;
  creator: Address;
  bindingExpiresAt: bigint;
  opDeadline: bigint;
  opNonce: bigint;
  parentOpDigest: Hex;
  repoFullName: string;
  revoke: boolean;
}

export interface Socials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

export const EMPTY_SOCIALS: Socials = { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };

/** Everything the factory hashes into TokenParams' metadata. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: Socials;
}

/** IForgeLaunchAuthorizer.LaunchIntent, with the RAW token metadata hash. */
export interface LaunchIntent {
  factory: Address;
  creator: Address;
  githubRepoId: bigint;
  launchConfigId: bigint;
  pairToken: Address;
  tokenMetadataHash: Hex;
  economicsDigest: Hex;
  salt: Hex;
  expiresAt: bigint;
  nonce: bigint;
  creatorTaxBps: number;
  exemptionListHash: Hex;
}

/** keccak256(abi.encode(name, symbol, logo, description, socials)) — PonsV2LaunchFactory._launchToken. */
export function tokenMetadataHash(m: TokenMetadata): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "string" },
        {
          type: "tuple",
          components: [
            { name: "twitter", type: "string" },
            { name: "telegram", type: "string" },
            { name: "discord", type: "string" },
            { name: "website", type: "string" },
            { name: "farcaster", type: "string" },
          ],
        },
      ],
      [m.name, m.symbol, m.logo, m.description, m.socials],
    ),
  );
}

/** ForgeLaunchAuthorizer._metadataHash — the effective metadata the creator signs. */
export function effectiveMetadataHash(raw: Hex, creatorFeeRecipient: Address, buybackEnabled: boolean, creatorTaxBps: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bool" }, { type: "uint16" }],
      [raw, creatorFeeRecipient, buybackEnabled, creatorTaxBps],
    ),
  );
}

/**
 * PonsV2LaunchFactory._canonicalExemptionHash: zero address refused, at
 * most 32 entries, sorted ascending (as uint160), then abi.encode(address[]).
 * Duplicates are NOT removed (the contract keeps them, so they change the hash).
 */
export function canonicalExemptionHash(exemptions: readonly string[]): Hex {
  if (exemptions.length > MAX_SNIPE_TAX_EXEMPTIONS) throw new Error("EXEMPTION_LIST_TOO_LONG");
  const sorted = exemptions.map((a) => {
    if (!isAddress(a, { strict: false })) throw new Error("INVALID_EXEMPTION_ADDRESS");
    const c = getAddress(a);
    if (c === ZERO_ADDRESS) throw new Error("INVALID_EXEMPTION_ADDRESS");
    return c;
  });
  sorted.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [sorted]));
}

/** The creator-consent typed-data message, exactly as the authorizer hashes it. */
export function launchAuthorizationMessage(intent: LaunchIntent, creatorFeeRecipient: Address, buybackEnabled: boolean) {
  return {
    factory: intent.factory,
    creator: intent.creator,
    githubRepoId: intent.githubRepoId,
    launchConfigId: intent.launchConfigId,
    pairToken: intent.pairToken,
    tokenMetadataHash: effectiveMetadataHash(intent.tokenMetadataHash, creatorFeeRecipient, buybackEnabled, intent.creatorTaxBps),
    economicsDigest: intent.economicsDigest,
    salt: intent.salt,
    expiresAt: intent.expiresAt,
    nonce: intent.nonce,
    creatorTaxBps: intent.creatorTaxBps,
    exemptionListHash: intent.exemptionListHash,
  } as const;
}

export interface EconomicsInputs {
  phantomQuote: bigint;
  graduationThreshold: bigint;
  supply: bigint;
  curveFeeBps: bigint;
  poolFee: number;
  tickSpacing: number;
  protocolFeeShareBps: number;
  buybackBurnBps: number;
  hookFeeBps: number;
  maxInternalPriceImpactBps: number;
}

/** PonsV2LaunchFactory._economicsDigest preimage (10 values, this order). */
export function economicsDigest(e: EconomicsInputs): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint24" },
        { type: "int24" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "uint16" },
      ],
      [
        e.phantomQuote,
        e.graduationThreshold,
        e.supply,
        e.curveFeeBps,
        e.poolFee,
        e.tickSpacing,
        e.protocolFeeShareBps,
        e.buybackBurnBps,
        e.hookFeeBps,
        e.maxInternalPriceImpactBps,
      ],
    ),
  );
}

/** Canonical attestation payload: abi.encodePacked(uint64 issuedAt, uint64 expiresAt, bytes65 sig). */
export function encodeAttestationPayload(issuedAt: bigint, expiresAt: bigint, signature: Hex): Hex {
  if ((signature.length - 2) / 2 !== 65) throw new Error("ATTESTATION_SIGNATURE_NOT_65_BYTES");
  return encodePacked(["uint64", "uint64", "bytes"], [issuedAt, expiresAt, signature]);
}

export function decodeAttestationPayload(payload: Hex): { issuedAt: bigint; expiresAt: bigint; signature: Hex } {
  if ((payload.length - 2) / 2 !== 81) throw new Error("BAD_ATTESTATION_ENCODING");
  return {
    issuedAt: BigInt(`0x${payload.slice(2, 18)}`),
    expiresAt: BigInt(`0x${payload.slice(18, 34)}`),
    signature: `0x${payload.slice(34)}` as Hex,
  };
}
