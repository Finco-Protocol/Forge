/**
 * Strict, minimal DER decoding for the two structures a secp256k1 KMS/HSM
 * returns: a SubjectPublicKeyInfo (GetPublicKey) and an ECDSA-Sig-Value
 * (Sign). Only definite, minimally-encoded lengths are accepted and the whole
 * input must be consumed — anything else is refused rather than "repaired".
 */
import { bytesToHex, type Hex } from "viem";

/** secp256k1 group order n and field prime p. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;
export const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;

// OID 1.2.840.10045.2.1 (id-ecPublicKey) and 1.3.132.0.10 (secp256k1), DER-encoded content bytes.
const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_SECP256K1 = [0x2b, 0x81, 0x04, 0x00, 0x0a];

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

export class DerError extends Error {
  constructor(message: string) {
    super(`DER: ${message}`);
    this.name = "DerError";
  }
}

interface Tlv {
  tag: number;
  /** content start (inclusive) and end (exclusive) */
  start: number;
  end: number;
}

function readTlv(b: Uint8Array, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new DerError("truncated header");
  const tag = b[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("high-tag-number form not allowed");
  let len = b[offset + 1]!;
  let p = offset + 2;
  if (len === 0x80) throw new DerError("indefinite length not allowed");
  if (len > 0x80) {
    const n = len & 0x7f;
    if (n > 2) throw new DerError("length too large");
    if (p + n > limit) throw new DerError("truncated length");
    if (b[p] === 0) throw new DerError("non-minimal length (leading zero)");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[p + i]!;
    if (len < 0x80) throw new DerError("non-minimal length (long form for short length)");
    p += n;
  }
  if (p + len > limit) throw new DerError("truncated content");
  return { tag, start: p, end: p + len };
}

function expectTag(t: Tlv, tag: number, what: string) {
  if (t.tag !== tag) throw new DerError(`expected ${what} (tag 0x${tag.toString(16)}), got 0x${t.tag.toString(16)}`);
}

function sameBytes(b: Uint8Array, t: Tlv, expected: number[]): boolean {
  if (t.end - t.start !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (b[t.start + i] !== expected[i]) return false;
  return true;
}

/** A DER INTEGER that must be positive and minimally encoded. */
function readPositiveInteger(b: Uint8Array, t: Tlv, what: string): bigint {
  expectTag(t, TAG_INTEGER, what);
  const len = t.end - t.start;
  if (len === 0) throw new DerError(`${what}: empty integer`);
  if (len > 33) throw new DerError(`${what}: integer longer than 33 bytes`);
  const first = b[t.start]!;
  if (first & 0x80) throw new DerError(`${what}: negative integer`);
  if (first === 0 && len > 1 && (b[t.start + 1]! & 0x80) === 0) throw new DerError(`${what}: non-minimal integer (redundant leading zero)`);
  let v = 0n;
  for (let i = t.start; i < t.end; i++) v = (v << 8n) | BigInt(b[i]!);
  return v;
}

export function isOnSecp256k1(x: bigint, y: bigint): boolean {
  if (x <= 0n || x >= SECP256K1_P || y <= 0n || y >= SECP256K1_P) return false;
  const p = SECP256K1_P;
  const lhs = (y * y) % p;
  const rhs = (((x * x) % p) * x + 7n) % p;
  return lhs === rhs;
}

/**
 * SubjectPublicKeyInfo (RFC 5480) for an id-ecPublicKey on secp256k1 →
 * the 65-byte uncompressed point 0x04‖X‖Y. Compressed points, other curves,
 * explicit parameters and points not on the curve are refused.
 */
export function parseSecp256k1Spki(der: Uint8Array): Hex {
  const outer = readTlv(der, 0, der.length);
  expectTag(outer, TAG_SEQUENCE, "SubjectPublicKeyInfo SEQUENCE");
  if (outer.end !== der.length) throw new DerError("trailing bytes after SubjectPublicKeyInfo");
  const alg = readTlv(der, outer.start, outer.end);
  expectTag(alg, TAG_SEQUENCE, "AlgorithmIdentifier SEQUENCE");
  const oid = readTlv(der, alg.start, alg.end);
  expectTag(oid, TAG_OID, "algorithm OID");
  if (!sameBytes(der, oid, OID_EC_PUBLIC_KEY)) throw new DerError("algorithm is not id-ecPublicKey");
  const curve = readTlv(der, oid.end, alg.end);
  expectTag(curve, TAG_OID, "namedCurve OID");
  if (!sameBytes(der, curve, OID_SECP256K1)) throw new DerError("named curve is not secp256k1");
  if (curve.end !== alg.end) throw new DerError("unexpected AlgorithmIdentifier parameters");
  const bits = readTlv(der, alg.end, outer.end);
  expectTag(bits, TAG_BIT_STRING, "subjectPublicKey BIT STRING");
  if (bits.end !== outer.end) throw new DerError("trailing bytes inside SubjectPublicKeyInfo");
  if (bits.end - bits.start !== 66) throw new DerError("public key is not a 65-byte uncompressed point");
  if (der[bits.start] !== 0x00) throw new DerError("BIT STRING has unused bits");
  if (der[bits.start + 1] !== 0x04) throw new DerError("public key point is not uncompressed (0x04)");
  const point = der.slice(bits.start + 1, bits.end);
  const x = BigInt(bytesToHex(point.slice(1, 33)));
  const y = BigInt(bytesToHex(point.slice(33, 65)));
  if (!isOnSecp256k1(x, y)) throw new DerError("public key point is not on secp256k1");
  return bytesToHex(point);
}

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }, with 1 ≤ r, s < n. */
export function parseDerEcdsaSignature(der: Uint8Array): { r: bigint; s: bigint } {
  const seq = readTlv(der, 0, der.length);
  expectTag(seq, TAG_SEQUENCE, "ECDSA-Sig-Value SEQUENCE");
  if (seq.end !== der.length) throw new DerError("trailing bytes after signature");
  const rT = readTlv(der, seq.start, seq.end);
  const r = readPositiveInteger(der, rT, "r");
  const sT = readTlv(der, rT.end, seq.end);
  const s = readPositiveInteger(der, sT, "s");
  if (sT.end !== seq.end) throw new DerError("trailing bytes inside signature");
  if (r < 1n || r >= SECP256K1_N) throw new DerError("r out of range");
  if (s < 1n || s >= SECP256K1_N) throw new DerError("s out of range");
  return { r, s };
}

/** EIP-2: Ethereum only accepts s ≤ n/2. */
export function normalizeLowS(s: bigint): bigint {
  return s > SECP256K1_HALF_N ? SECP256K1_N - s : s;
}
