/**
 * GCP Cloud KMS backend (key algorithm EC_SIGN_SECP256K1_SHA256, HSM
 * protection level). Shaped on `KeyManagementServiceClient.asymmetricSign`
 * and `getPublicKey`; the Node client returns `[response]` tuples, so the
 * operator adapter is `{ asymmetricSign: async (r) => (await kms.asymmetricSign(r))[0], … }`.
 * Not a dependency of this build and never exercised against real GCP.
 */
import { KmsError, type Secp256k1KmsBackend } from "./backend";

export interface GcpKmsClient {
  asymmetricSign(req: { name: string; digest: { sha256: Uint8Array } }): Promise<{ signature?: Uint8Array; name?: string }>;
  getPublicKey(req: { name: string }): Promise<{ pem?: string; algorithm?: string; name?: string }>;
}

const VERSION_NAME = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/\d+$/;

export function pemToDer(pem: string): Uint8Array {
  const m = /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PUBLIC KEY-----\r?\n?$/.exec(pem.trim() + "\n");
  if (!m) throw new KmsError("public key is not a single PEM 'PUBLIC KEY' block");
  return new Uint8Array(Buffer.from(m[1]!.replace(/\s+/g, ""), "base64"));
}

export function gcpKmsBackend(client: GcpKmsClient, keyVersionName: string): Secp256k1KmsBackend {
  // A specific key VERSION, never a key: rotation is an explicit config change.
  if (!VERSION_NAME.test(keyVersionName)) throw new KmsError(`invalid GCP cryptoKeyVersion name ${JSON.stringify(keyVersionName)}`);
  const checkName = (n: string | undefined, op: string) => {
    if (n !== undefined && n !== keyVersionName) throw new KmsError(`${op} answered for ${n}, expected ${keyVersionName}`);
  };
  return {
    describe: `gcp-kms:${keyVersionName}`,
    async getPublicKeySpki() {
      const out = await client.getPublicKey({ name: keyVersionName });
      checkName(out.name, "getPublicKey");
      if (out.algorithm !== "EC_SIGN_SECP256K1_SHA256") throw new KmsError(`algorithm ${out.algorithm ?? "?"} is not EC_SIGN_SECP256K1_SHA256`);
      if (!out.pem) throw new KmsError("getPublicKey returned no PEM");
      return pemToDer(out.pem);
    },
    async signDigestDer(digest: Uint8Array) {
      if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new KmsError("digest must be exactly 32 bytes");
      // GCP names the field sha256 but signs the supplied 32 bytes as-is (no re-hash).
      const out = await client.asymmetricSign({ name: keyVersionName, digest: { sha256: digest } });
      checkName(out.name, "asymmetricSign");
      if (!(out.signature instanceof Uint8Array) || out.signature.length === 0) throw new KmsError("asymmetricSign returned no signature");
      return out.signature;
    },
  };
}
