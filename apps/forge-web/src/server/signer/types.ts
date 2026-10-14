import type { Address, Hex } from "viem";

/**
 * Custody boundary. A DigestSigner signs a 32-byte digest with secp256k1 and
 * returns a 65-byte r||s||v signature — exactly the operation AWS KMS
 * (ECC_SECG_P256K1, MessageType=DIGEST), GCP KMS or an HSM exposes. It never
 * sees structured data and enforces no policy: the AuthoritySigner policy
 * layer decides WHAT may be signed before any digest reaches custody.
 */
export interface DigestSigner {
  readonly role: "authority" | "evidence";
  readonly custody: "local-test" | "kms" | "hsm";
  readonly address: Address;
  signDigest(digest: Hex): Promise<Hex>;
}
