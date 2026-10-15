/**
 * AWS KMS backend, modelled field-for-field on the AWS SDK v3 `SignCommand`
 * and `GetPublicKeyCommand` inputs/outputs. The SDK is NOT a dependency of
 * this build; an operator wires a real client with a two-line adapter:
 *
 *   const kms = new KMSClient({ region });
 *   const client: AwsKmsSignClient = {
 *     sign: (i) => kms.send(new SignCommand(i)),
 *     getPublicKey: (i) => kms.send(new GetPublicKeyCommand(i)),
 *   };
 *
 * Key requirements (enforced on GetPublicKey): KeySpec ECC_SECG_P256K1,
 * KeyUsage SIGN_VERIFY, SigningAlgorithms ∋ ECDSA_SHA_256. Every Sign call is
 * MessageType=DIGEST over exactly 32 bytes, so KMS never re-hashes the
 * EIP-712/EIP-191 digest. See ops/iam/ for the matching key/IAM policies.
 */
import { KmsError, type Secp256k1KmsBackend } from "./backend";

export interface AwsKmsSignInput {
  KeyId: string;
  Message: Uint8Array;
  MessageType: "DIGEST";
  SigningAlgorithm: "ECDSA_SHA_256";
}
export interface AwsKmsSignOutput {
  KeyId?: string;
  Signature?: Uint8Array;
  SigningAlgorithm?: string;
}
export interface AwsKmsGetPublicKeyInput {
  KeyId: string;
}
export interface AwsKmsGetPublicKeyOutput {
  KeyId?: string;
  PublicKey?: Uint8Array;
  KeySpec?: string;
  KeyUsage?: string;
  SigningAlgorithms?: string[];
}

/** The only two AWS KMS operations Forge calls. */
export interface AwsKmsSignClient {
  sign(input: AwsKmsSignInput): Promise<AwsKmsSignOutput>;
  getPublicKey(input: AwsKmsGetPublicKeyInput): Promise<AwsKmsGetPublicKeyOutput>;
}

const KEY_ID = /^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+|alias\/[A-Za-z0-9/_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;

export function awsKmsBackend(client: AwsKmsSignClient, keyId: string): Secp256k1KmsBackend {
  if (!KEY_ID.test(keyId)) throw new KmsError(`invalid AWS KMS KeyId ${JSON.stringify(keyId)}`);
  const isKeyArn = keyId.startsWith("arn:") && keyId.includes(":key/");
  // The response KeyId is always the key ARN. When the configured id is itself a key ARN
  // it must match exactly; an alias/bare id is pinned to the ARN first seen on GetPublicKey.
  let pinnedArn: string | null = isKeyArn ? keyId : null;
  const checkKeyId = (returned: string | undefined, op: string) => {
    if (returned === undefined) return;
    if (pinnedArn === null) pinnedArn = returned;
    else if (returned !== pinnedArn) throw new KmsError(`${op} answered for key ${returned}, expected ${pinnedArn}`);
  };
  return {
    describe: `aws-kms:${keyId}`,
    async getPublicKeySpki() {
      const out = await client.getPublicKey({ KeyId: keyId });
      checkKeyId(out.KeyId, "GetPublicKey");
      if (out.KeySpec !== "ECC_SECG_P256K1") throw new KmsError(`KeySpec ${out.KeySpec ?? "?"} is not ECC_SECG_P256K1`);
      if (out.KeyUsage !== "SIGN_VERIFY") throw new KmsError(`KeyUsage ${out.KeyUsage ?? "?"} is not SIGN_VERIFY`);
      if (!out.SigningAlgorithms?.includes("ECDSA_SHA_256")) throw new KmsError("key does not offer ECDSA_SHA_256");
      if (!(out.PublicKey instanceof Uint8Array) || out.PublicKey.length === 0) throw new KmsError("GetPublicKey returned no PublicKey");
      return out.PublicKey;
    },
    async signDigestDer(digest: Uint8Array) {
      if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new KmsError("digest must be exactly 32 bytes");
      const out = await client.sign({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" });
      checkKeyId(out.KeyId, "Sign");
      if (out.SigningAlgorithm !== undefined && out.SigningAlgorithm !== "ECDSA_SHA_256") throw new KmsError(`Sign used ${out.SigningAlgorithm}`);
      if (!(out.Signature instanceof Uint8Array) || out.Signature.length === 0) throw new KmsError("Sign returned no Signature");
      return out.Signature;
    },
  };
}
