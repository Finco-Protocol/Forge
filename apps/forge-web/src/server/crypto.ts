import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const uuid = () => randomUUID();

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function key(secret: string, purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}\0${secret}`).digest();
}

/** AES-256-GCM, key derived from SESSION_SECRET per purpose. Output: iv.tag.ciphertext (base64url). */
export function encrypt(secret: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret, purpose), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(secret: string, purpose: string, blob: string): string {
  const [iv, tag, ct] = blob.split(".").map((s) => Buffer.from(s, "base64url"));
  if (!iv || !tag || !ct) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", key(secret, purpose), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Deterministic JSON (sorted keys, bigint as decimal string) for evidence hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
