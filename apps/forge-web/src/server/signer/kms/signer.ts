/**
 * KmsDigestSigner — a DigestSigner whose key lives in a remote secp256k1
 * custody (AWS/GCP KMS, HSM). The Ethereum address is DERIVED from the
 * custody's public key (never configured on trust); every signature is
 * parsed from DER, normalised to low-s (EIP-2), given the recovery id that
 * recovers to that address, and re-verified before it is returned.
 *
 * PRODUCTION_SIGNING_ENABLED=false: construction is refused for chain 4663
 * and every chain except the local dev chains, exactly like the local-test
 * signer. The adapter compiles and is tested against a fake KMS only.
 */
import { getAddress, hexToBytes, keccak256, recoverAddress, serializeSignature, numberToHex, type Address, type Hex } from "viem";
import { PRODUCTION_SIGNING_ENABLED, ROBINHOOD_CHAIN_ID } from "../../config";
import { LOCAL_DEV_CHAIN_IDS } from "../local";
import type { DigestSigner } from "../types";
import { KmsError, type Secp256k1KmsBackend } from "./backend";
import { normalizeLowS, parseDerEcdsaSignature, parseSecp256k1Spki } from "./der";

const DIGEST = /^0x[0-9a-fA-F]{64}$/;

/** Ethereum address of an uncompressed secp256k1 point 0x04‖X‖Y. */
export function addressFromUncompressedPoint(point: Hex): Address {
  const bytes = hexToBytes(point);
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new KmsError("expected a 65-byte uncompressed point");
  return getAddress(`0x${keccak256(bytes.slice(1)).slice(-40)}`);
}

export function assertSigningChainAllowed(chainId: number, what: string) {
  if (PRODUCTION_SIGNING_ENABLED) return;
  if (chainId === ROBINHOOD_CHAIN_ID) throw new Error(`PRODUCTION_BLOCKED: ${what} refused for chain 4663 (PRODUCTION_SIGNING_ENABLED=false).`);
  if (!LOCAL_DEV_CHAIN_IDS.has(chainId)) throw new Error(`PRODUCTION_BLOCKED: ${what} refused for chain ${chainId} (PRODUCTION_SIGNING_ENABLED=false; local dev chains only).`);
}

/** Turns a DER (r, s) into the 65-byte r‖s‖v Ethereum signature that recovers to `address`. */
export async function toEthereumSignature(digest: Hex, der: Uint8Array, address: Address): Promise<Hex> {
  const { r, s: rawS } = parseDerEcdsaSignature(der);
  const s = normalizeLowS(rawS);
  const rHex = numberToHex(r, { size: 32 });
  const sHex = numberToHex(s, { size: 32 });
  const matches: Hex[] = [];
  for (const yParity of [0, 1] as const) {
    const sig = serializeSignature({ r: rHex, s: sHex, yParity });
    try {
      if ((await recoverAddress({ hash: digest, signature: sig })) === address) matches.push(sig);
    } catch {
      /* not a valid point for this parity */
    }
  }
  if (matches.length !== 1) throw new KmsError(`signature does not recover to ${address} (${matches.length} candidates)`);
  return matches[0]!;
}

export class KmsDigestSigner implements DigestSigner {
  readonly custody = "kms" as const;

  private constructor(
    readonly role: DigestSigner["role"],
    readonly address: Address,
    readonly publicKey: Hex,
    private readonly backend: Secp256k1KmsBackend,
    private readonly chainId: number,
  ) {}

  get describe(): string {
    return this.backend.describe;
  }

  /** Fetches the public key from custody and derives the address. Refused on non-dev chains while production signing is disabled. */
  static async create(role: DigestSigner["role"], backend: Secp256k1KmsBackend, opts: { chainId: number }): Promise<KmsDigestSigner> {
    assertSigningChainAllowed(opts.chainId, `KMS ${role} signer`);
    const publicKey = parseSecp256k1Spki(await backend.getPublicKeySpki());
    return new KmsDigestSigner(role, addressFromUncompressedPoint(publicKey), publicKey, backend, opts.chainId);
  }

  async signDigest(digest: Hex): Promise<Hex> {
    if (typeof digest !== "string" || !DIGEST.test(digest)) throw new KmsError("digest must be a 0x-prefixed 32-byte hex string");
    assertSigningChainAllowed(this.chainId, `KMS ${this.role} signer`);
    const der = await this.backend.signDigestDer(hexToBytes(digest));
    return toEthereumSignature(digest, der, this.address);
  }
}
