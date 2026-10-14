/**
 * The narrow seam between Forge and a remote secp256k1 custody (AWS KMS, GCP
 * KMS, an HSM). Both operations are all a signing role ever needs; there is
 * deliberately no import/export, decrypt, key-creation or key-deletion call.
 * No cloud SDK is bundled in this build: the process that enables KMS
 * custody injects a backend (see aws.ts / gcp.ts for the exact shapes).
 */
export interface Secp256k1KmsBackend {
  /** Non-secret description for logs/audit, e.g. "aws-kms:arn:aws:kms:…:key/…". */
  readonly describe: string;
  /** DER SubjectPublicKeyInfo of the signing key. */
  getPublicKeySpki(): Promise<Uint8Array>;
  /** DER ECDSA-Sig-Value over the given 32-byte digest (no further hashing). */
  signDigestDer(digest: Uint8Array): Promise<Uint8Array>;
}

export class KmsError extends Error {
  constructor(message: string) {
    super(`KMS: ${message}`);
    this.name = "KmsError";
  }
}
