/**
 * W08 RPC outage probe, Compose-only. Initialize a real PostgreSQL-backed
 * context while Anvil is healthy; expose readiness BEFORE any outage.
 * Only an audited chain-unavailable guard denial passes.
 */
import { access, writeFile } from "node:fs/promises";
import { buildConfig } from "../src/server/config";
import { createAppContext } from "../src/server/context";
import { registryDomain, bindingOpTypes } from "../src/shared/forge-typed-data";
import { zeroAddress } from "viem";

const id = process.env.SIGN_PROBE_ID;
if (!id || !/^[0-9a-f]{24}$/.test(id)) throw new Error("SIGN_PROBE_ID must be a fresh lowercase 24-digit hex token");
const base = "/sandbox/w08-sign-probe-" + id;
const cfg = buildConfig(process.env);
const ctx = await createAppContext(process.env);
try {
  if (ctx.db.stats().driver !== "pg" || !process.env.DATABASE_URL) throw new Error("SIGN_PROBE_REQUIRES_COMPOSE_POSTGRES");
  const signer = ctx.signers.guarded("authority");
  if (!signer) throw new Error("SIGN_PROBE_MISSING_AUTHORITY_GUARD");
  await writeFile(base + ".ready", "SIGN_PROBE_READY\n", { flag: "wx" });
  console.log("SIGN_PROBE_PHASE_A_READY");

  const deadline = Date.now() + 100_000;
  let triggered = false;
  while (Date.now() < deadline) {
    try {
      await access(base + ".go");
      triggered = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!triggered) throw new Error("SIGN_PROBE_TRIGGER_TIMEOUT");
  console.log("SIGN_PROBE_PHASE_B_TRIGGERED");
  // BindingOp fields are uint64: derive the probe nonce from the LAST 15 hex
  // chars of the id (<= 2^60), never the full 24-char token (96 bits would be
  // rejected by the message validation BEFORE the guard's fail-closed read).
  const nonce = BigInt("0x" + id.slice(-15)) + 1n;
  let refused = false;
  try {
    await signer.signTypedData({
      domain: registryDomain(cfg.chainId, cfg.addresses.registry),
      types: bindingOpTypes,
      primaryType: "BindingOp",
      message: {
        githubRepoId: nonce, creator: zeroAddress,
        bindingExpiresAt: 4_000_000_000n, opDeadline: 4_000_000_000n,
        opNonce: nonce, parentOpDigest: "0x" + "00".repeat(32),
        repoFullName: "o/r", revoke: false,
      },
    }, { requestedBy: "w08-sign-probe", correlationId: "w08-" + id });
    console.error("SIGN_PROBE_RESULT=SIGNED (hard failure)");
  } catch (e) {
    const msg = (e as Error).message.split("\n")[0] ?? "";
    if (/authoritative on-chain read failed \(fail closed\)/i.test(msg)) {
      console.log("SIGN_PROBE_RESULT=REFUSED_FAIL_CLOSED: " + msg);
      refused = true;
    } else {
      console.error("SIGN_PROBE_RESULT=UNEXPECTED_REFUSAL: " + msg);
    }
  }
  if (!refused) process.exitCode = 1;
} finally {
  await ctx.db.close();
}
