/**
 * TEST-ONLY fake AWS KMS / GCP KMS for secp256k1 keys. Signs with
 * @noble/curves (resolved through viem, which already depends on it — no new
 * dependency), returns DER ECDSA signatures and deliberately returns HIGH-s
 * signatures (s > n/2) on a configurable schedule, exactly what a real KMS
 * may do (KMS does not apply EIP-2). Public keys are DER SPKI produced by
 * Node's OpenSSL (an encoder independent of the parser under test).
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import { hexToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AwsKmsGetPublicKeyInput, AwsKmsGetPublicKeyOutput, AwsKmsSignClient, AwsKmsSignInput, AwsKmsSignOutput } from "@/server/signer/kms/aws";
import type { GcpKmsClient } from "@/server/signer/kms/gcp";

interface NobleSignature {
  r: bigint;
  s: bigint;
  hasHighS(): boolean;
  toDERRawBytes(): Uint8Array;
}
interface NobleSecp256k1 {
  sign(msgHash: Uint8Array, privKey: Uint8Array, opts?: { lowS?: boolean }): NobleSignature;
  getPublicKey(privKey: Uint8Array, compressed?: boolean): Uint8Array;
  Signature: new (r: bigint, s: bigint) => NobleSignature;
  CURVE: { n: bigint };
}

const requireFromViem = createRequire(createRequire(import.meta.url).resolve("viem"));
export const secp256k1 = (requireFromViem("@noble/curves/secp256k1") as { secp256k1: NobleSecp256k1 }).secp256k1;

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** DER SPKI of a secp256k1 private key's public point, encoded by Node/OpenSSL. */
export function opensslSpki(privateKey: Hex): Uint8Array {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  const jwk = { kty: "EC", crv: "secp256k1", d: b64u(hexToBytes(privateKey)), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) };
  const der = createPublicKey(createPrivateKey({ key: jwk, format: "jwk" })).export({ type: "spki", format: "der" });
  return new Uint8Array(der);
}

export type HighSMode = "alternate" | "always" | "never";

export interface FakeKey {
  privateKey: Hex;
  keySpec?: string;
  keyUsage?: string;
}

export class FakeAwsKms implements AwsKmsSignClient {
  readonly keys = new Map<string, FakeKey>();
  readonly signCalls: AwsKmsSignInput[] = [];
  highSReturned = 0;
  lowSReturned = 0;
  private counter = 0;
  /** Test hook: answer Sign for `keyId` with another key's signature (corrupted custody). */
  readonly signWith = new Map<string, Hex>();
  /** Test hook: report a different KeyId in responses. */
  readonly reportKeyId = new Map<string, string>();

  constructor(public highS: HighSMode = "alternate") {}

  add(keyId: string, key: FakeKey | Hex) {
    this.keys.set(keyId, typeof key === "string" ? { privateKey: key } : key);
    return this;
  }

  address(keyId: string) {
    return privateKeyToAccount(this.keys.get(keyId)!.privateKey).address;
  }

  private key(keyId: string): FakeKey {
    const k = this.keys.get(keyId);
    if (!k) throw Object.assign(new Error(`NotFoundException: key ${keyId}`), { name: "NotFoundException" });
    return k;
  }

  async getPublicKey(input: AwsKmsGetPublicKeyInput): Promise<AwsKmsGetPublicKeyOutput> {
    const k = this.key(input.KeyId);
    return {
      KeyId: this.reportKeyId.get(input.KeyId) ?? input.KeyId,
      PublicKey: opensslSpki(k.privateKey),
      KeySpec: k.keySpec ?? "ECC_SECG_P256K1",
      KeyUsage: k.keyUsage ?? "SIGN_VERIFY",
      SigningAlgorithms: ["ECDSA_SHA_256"],
    };
  }

  async sign(input: AwsKmsSignInput): Promise<AwsKmsSignOutput> {
    this.signCalls.push(input);
    if (input.MessageType !== "DIGEST" || input.SigningAlgorithm !== "ECDSA_SHA_256") throw new Error("ValidationException: unsupported Sign request");
    if (!(input.Message instanceof Uint8Array) || input.Message.length !== 32) throw new Error("ValidationException: DIGEST must be 32 bytes");
    const k = this.key(input.KeyId);
    const priv = this.signWith.get(input.KeyId) ?? k.privateKey;
    const low = secp256k1.sign(input.Message, hexToBytes(priv), { lowS: true });
    const wantHigh = this.highS === "always" || (this.highS === "alternate" && this.counter++ % 2 === 0);
    const sig = wantHigh ? new secp256k1.Signature(low.r, secp256k1.CURVE.n - low.s) : low;
    if (sig.hasHighS()) this.highSReturned++;
    else this.lowSReturned++;
    return { KeyId: this.reportKeyId.get(input.KeyId) ?? input.KeyId, Signature: sig.toDERRawBytes(), SigningAlgorithm: "ECDSA_SHA_256" };
  }
}

/** Same custody, GCP-shaped (PEM public key, asymmetricSign over digest.sha256). */
export class FakeGcpKms implements GcpKmsClient {
  constructor(private readonly aws: FakeAwsKms) {}
  async getPublicKey(req: { name: string }) {
    const der = (await this.aws.getPublicKey({ KeyId: req.name })).PublicKey!;
    const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
    return { name: req.name, algorithm: "EC_SIGN_SECP256K1_SHA256", pem: `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n` };
  }
  async asymmetricSign(req: { name: string; digest: { sha256: Uint8Array } }) {
    const out = await this.aws.sign({ KeyId: req.name, Message: req.digest.sha256, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" });
    return { name: req.name, signature: out.Signature };
  }
}

let n = 0;
export const fakeKeyArn = () => `arn:aws:kms:us-east-1:111122223333:key/${(++n).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
