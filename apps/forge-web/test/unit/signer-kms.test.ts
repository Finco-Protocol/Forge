import { createHash, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToHex, getAddress, hashTypedData, keccak256, recoverAddress, recoverTypedDataAddress, toBytes, zeroAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, serializeSignature, sign } from "viem/accounts";
import { bindingOpTypes, eligibilityAttestationTypes, launchDomain, registryDomain } from "@/shared/forge-typed-data";
import { ELIGIBLE_REVENUE_TYPES, SPLITTER_EIP712_DOMAIN, eligibleRevenueDigest, type EligibleRevenueAuth } from "@/server/finance/attestor";
import { DerError, SECP256K1_HALF_N, SECP256K1_N, parseDerEcdsaSignature, parseSecp256k1Spki } from "@/server/signer/kms/der";
import { awsKmsBackend } from "@/server/signer/kms/aws";
import { gcpKmsBackend } from "@/server/signer/kms/gcp";
import { KmsDigestSigner, addressFromUncompressedPoint, toEthereumSignature } from "@/server/signer/kms/signer";
import { assertDistinctServerKeys } from "@/server/signer/registry";
import { FakeAwsKms, FakeGcpKms, fakeKeyArn, opensslSpki, secp256k1 } from "../helpers/fake-kms";

const sOf = (sig: Hex) => BigInt(`0x${sig.slice(66, 130)}`);
const der = (hex: string) => new Uint8Array(Buffer.from(hex.replace(/\s+/g, ""), "hex"));

describe("W05 KMS: DER SubjectPublicKeyInfo → Ethereum address", () => {
  it("parses OpenSSL-encoded secp256k1 SPKI and derives the same address as the private key", () => {
    for (let i = 0; i < 20; i++) {
      const pk = generatePrivateKey();
      const point = parseSecp256k1Spki(opensslSpki(pk));
      expect(addressFromUncompressedPoint(point)).toBe(privateKeyToAccount(pk).address);
    }
  });

  it("refuses other curves, compressed points, off-curve points, trailing bytes and non-minimal lengths", () => {
    const p256 = new Uint8Array(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }));
    expect(() => parseSecp256k1Spki(p256)).toThrow(/not secp256k1/);
    const good = opensslSpki(generatePrivateKey());
    expect(() => parseSecp256k1Spki(new Uint8Array([...good, 0x00]))).toThrow(DerError);
    const offCurve = good.slice();
    offCurve[offCurve.length - 1]! ^= 0x01;
    expect(() => parseSecp256k1Spki(offCurve)).toThrow(/not on secp256k1/);
    // Compressed point: SEQUENCE{ alg, BIT STRING(0x00 ‖ 0x02 ‖ X) }
    const pub = secp256k1.getPublicKey(toBytes(generatePrivateKey()), true);
    const alg = good.slice(2, 2 + 2 + good[3]!);
    const bits = new Uint8Array([0x03, pub.length + 1, 0x00, ...pub]);
    const compressed = new Uint8Array([0x30, alg.length + bits.length, ...alg, ...bits]);
    expect(() => parseSecp256k1Spki(compressed)).toThrow(/uncompressed/);
    // Long-form length used for a short length (non-DER).
    const nonMinimal = new Uint8Array([0x30, 0x81, good[1]!, ...good.slice(2)]);
    expect(() => parseSecp256k1Spki(nonMinimal)).toThrow(/non-minimal length/);
    expect(() => parseSecp256k1Spki(new Uint8Array([0x30, 0x80, 0x00, 0x00]))).toThrow(/indefinite/);
  });
});

describe("W05 KMS: DER ECDSA signature → low-s r‖s‖v", () => {
  it("normalises OpenSSL's (non-EIP-2) signatures and finds the recovery id against the known address", async () => {
    let high = 0;
    for (let i = 0; i < 40; i++) {
      const pk = generatePrivateKey();
      const address = privateKeyToAccount(pk).address;
      const pub = secp256k1.getPublicKey(toBytes(pk), false);
      const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
      const key = { key: { kty: "EC", crv: "secp256k1", d: b64u(toBytes(pk)), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)) }, format: "jwk" as const };
      const data = Buffer.from(`forge-w05-${i}`);
      const sigDer = new Uint8Array(nodeSign("sha256", data, key)); // OpenSSL DER over sha256(data)
      const digest = bytesToHex(createHash("sha256").update(data).digest());
      if (parseDerEcdsaSignature(sigDer).s > SECP256K1_HALF_N) high++;
      const sig = await toEthereumSignature(digest, sigDer, address);
      expect(sOf(sig) <= SECP256K1_HALF_N).toBe(true);
      expect(await recoverAddress({ hash: digest, signature: sig })).toBe(address);
    }
    expect(high).toBeGreaterThan(0); // OpenSSL does not apply EIP-2: high-s really occurred
  });

  it("refuses malformed DER: negative/non-minimal integers, zero or out-of-range r/s, trailing bytes", () => {
    const one = "020101";
    expect(parseDerEcdsaSignature(der(`3006${one}${one}`))).toEqual({ r: 1n, s: 1n });
    expect(() => parseDerEcdsaSignature(der(`3006020180${one}`))).toThrow(/negative/);
    expect(() => parseDerEcdsaSignature(der(`30070202000${"1"}${one}`))).toThrow(/non-minimal integer/);
    expect(() => parseDerEcdsaSignature(der(`3006020100${one}`))).toThrow(/r out of range/);
    const nHex = SECP256K1_N.toString(16);
    expect(() => parseDerEcdsaSignature(der(`3026${one}022100${nHex}`))).toThrow(/s out of range/);
    expect(() => parseDerEcdsaSignature(der(`3006${one}${one}00`))).toThrow(/trailing/);
    expect(() => parseDerEcdsaSignature(der(`3007${one}${one}00`))).toThrow(/trailing bytes inside/);
    expect(() => parseDerEcdsaSignature(der(`3106${one}${one}`))).toThrow(/SEQUENCE/);
  });

  it("refuses a signature that does not recover to the custody address", async () => {
    const digest = keccak256(toBytes("x"));
    const other = secp256k1.sign(toBytes(digest), toBytes(generatePrivateKey()), { lowS: true }).toDERRawBytes();
    await expect(toEthereumSignature(digest, other, privateKeyToAccount(generatePrivateKey()).address)).rejects.toThrow(/does not recover/);
  });
});

describe("W05 KMS: KmsDigestSigner over a fake AWS KMS (DIGEST / ECDSA_SHA_256 / ECC_SECG_P256K1)", () => {
  const chainId = 31337;
  const registry = getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3");
  const authorizer = getAddress("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512");
  const splitter = getAddress("0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0");

  it("signs EIP-712 digests from the app's typed-data helpers; high-s KMS answers are normalised; output equals the RFC 6979 local signature", async () => {
    const kms = new FakeAwsKms("alternate");
    const keyId = fakeKeyArn();
    const pk = generatePrivateKey();
    kms.add(keyId, pk);
    const signer = await KmsDigestSigner.create("authority", awsKmsBackend(kms, keyId), { chainId });
    expect(signer.address).toBe(privateKeyToAccount(pk).address);
    expect(signer.custody).toBe("kms");
    for (let i = 0; i < 12; i++) {
      const op = { githubRepoId: BigInt(1000 + i), creator: privateKeyToAccount(generatePrivateKey()).address, bindingExpiresAt: 2_000_000_000n, opDeadline: 1_900_000_000n, opNonce: BigInt(i + 1), parentOpDigest: keccak256(toBytes(`p${i}`)), repoFullName: `org/repo-${i}`, revoke: false };
      const typed = { domain: registryDomain(chainId, registry), types: bindingOpTypes, primaryType: "BindingOp", message: op } as const;
      const digest = hashTypedData(typed);
      const sig = await signer.signDigest(digest);
      expect(sOf(sig) <= SECP256K1_HALF_N).toBe(true);
      expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(signer.address);
      expect(sig).toBe(serializeSignature(await sign({ hash: digest, privateKey: pk })));
    }
    const att = { githubRepoId: 7n, creator: privateKeyToAccount(generatePrivateKey()).address, bindingEpoch: 1n, issuedAt: 1n, expiresAt: 2n };
    const attTyped = { domain: launchDomain(chainId, authorizer), types: eligibilityAttestationTypes, primaryType: "EligibilityAttestation", message: att } as const;
    expect(await recoverTypedDataAddress({ ...attTyped, signature: await signer.signDigest(hashTypedData(attTyped)) })).toBe(signer.address);
    const auth: EligibleRevenueAuth = { escrow: authorizer, factory: registry, asset: zeroAddress, cumulativeEligible: 10n ** 18n, nonce: 1n, deadline: 2n, evidenceBlock: 3n, evidenceBlockHash: keccak256(toBytes("b")) };
    const revSig = await signer.signDigest(eligibleRevenueDigest(chainId, splitter, auth));
    expect(await recoverTypedDataAddress({ domain: { ...SPLITTER_EIP712_DOMAIN, chainId, verifyingContract: splitter }, types: ELIGIBLE_REVENUE_TYPES, primaryType: "EligibleRevenue", message: auth, signature: revSig })).toBe(signer.address);
    expect(kms.highSReturned).toBeGreaterThan(0);
    expect(kms.lowSReturned).toBeGreaterThan(0);
    expect(kms.signCalls.every((c) => c.MessageType === "DIGEST" && c.SigningAlgorithm === "ECDSA_SHA_256" && c.Message.length === 32 && c.KeyId === keyId)).toBe(true);
  });

  it("refuses chain 4663 and non-dev chains (PRODUCTION_SIGNING_ENABLED=false)", async () => {
    const kms = new FakeAwsKms().add("alias/forge-authority", generatePrivateKey());
    const be = awsKmsBackend(kms, "alias/forge-authority");
    await expect(KmsDigestSigner.create("authority", be, { chainId: 4663 })).rejects.toThrow(/PRODUCTION_BLOCKED.*4663/);
    await expect(KmsDigestSigner.create("authority", be, { chainId: 11155111 })).rejects.toThrow(/PRODUCTION_BLOCKED/);
    await expect(KmsDigestSigner.create("authority", be, { chainId: 1337 })).resolves.toBeInstanceOf(KmsDigestSigner);
  });

  it("strict input validation: key id, key spec/usage, answering key, digest shape, corrupted custody", async () => {
    const kms = new FakeAwsKms();
    expect(() => awsKmsBackend(kms, "not a key id")).toThrow(/invalid AWS KMS KeyId/);
    const p256 = fakeKeyArn();
    kms.add(p256, { privateKey: generatePrivateKey(), keySpec: "ECC_NIST_P256" });
    await expect(KmsDigestSigner.create("authority", awsKmsBackend(kms, p256), { chainId })).rejects.toThrow(/ECC_SECG_P256K1/);
    const enc = fakeKeyArn();
    kms.add(enc, { privateKey: generatePrivateKey(), keyUsage: "ENCRYPT_DECRYPT" });
    await expect(KmsDigestSigner.create("authority", awsKmsBackend(kms, enc), { chainId })).rejects.toThrow(/SIGN_VERIFY/);
    const swapped = fakeKeyArn();
    kms.add(swapped, generatePrivateKey());
    kms.reportKeyId.set(swapped, fakeKeyArn());
    await expect(KmsDigestSigner.create("authority", awsKmsBackend(kms, swapped), { chainId })).rejects.toThrow(/answered for key/);
    const ok = fakeKeyArn();
    kms.add(ok, generatePrivateKey());
    const signer = await KmsDigestSigner.create("evidence", awsKmsBackend(kms, ok), { chainId });
    await expect(signer.signDigest("0x1234" as Hex)).rejects.toThrow(/32-byte/);
    await expect(signer.signDigest(`0x${"zz".repeat(32)}` as Hex)).rejects.toThrow(/32-byte/);
    kms.signWith.set(ok, generatePrivateKey()); // custody answers with a different key
    await expect(signer.signDigest(keccak256(toBytes("d")))).rejects.toThrow(/does not recover/);
  });

  it("GCP-shaped backend (PEM public key, asymmetricSign) yields the same signer", async () => {
    const aws = new FakeAwsKms("always");
    const name = "projects/forge-test-1/locations/global/keyRings/forge/cryptoKeys/authority/cryptoKeyVersions/1";
    const pk = generatePrivateKey();
    aws.add(name, pk);
    expect(() => gcpKmsBackend(new FakeGcpKms(aws), "projects/x/keys/y")).toThrow(/cryptoKeyVersion/);
    const signer = await KmsDigestSigner.create("revenue", gcpKmsBackend(new FakeGcpKms(aws), name), { chainId });
    expect(signer.address).toBe(privateKeyToAccount(pk).address);
    const digest = keccak256(toBytes("gcp"));
    expect(await recoverAddress({ hash: digest, signature: await signer.signDigest(digest) })).toBe(signer.address);
    expect(aws.highSReturned).toBe(1);
  });
});

describe("W05 role separation", () => {
  it("any two server-held roles sharing a key is refused", () => {
    const a = privateKeyToAccount(generatePrivateKey()).address;
    const b = privateKeyToAccount(generatePrivateKey()).address;
    expect(() => assertDistinctServerKeys({ authority: a, evidence: b, relayer: a.toLowerCase() as Hex })).toThrow(/authority and relayer share/);
    expect(() => assertDistinctServerKeys({ authority: a, evidence: b, revenue: null })).not.toThrow();
  });
});
