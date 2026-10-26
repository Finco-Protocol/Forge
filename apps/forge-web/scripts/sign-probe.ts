/**
 * W08 RPC-outage drill probe (test-only; compose staging stack): attempts a
 * REAL custody signing request through the production signing-policy guard
 * while the chain RPC is unreachable, and verifies the refusal is the guard's
 * fail-closed path (exit 0 = refused without any custody call; nonzero = the
 * attempt did not fail closed, which fails the drill).
 */
import { buildConfig } from "../src/server/config";
import { PgliteDb } from "../src/server/db";
import { createAppContext } from "../src/server/context";
import { registryDomain } from "../src/shared/forge-typed-data";
import { bindingOpTypes } from "../src/shared/forge-typed-data";
import { zeroAddress } from "viem";

const cfg = buildConfig(process.env);
const db = await PgliteDb.open();
const ctx = await createAppContext(process.env, { db });
// W08 drill protocol: the context is created while the chain is REACHABLE (startup
// verification needs it); the drill then pauses anvil and this wait lands the
// signing attempt squarely in the outage window, so the GUARD's per-request
// freshness check is what must refuse - not the startup.
if (process.env.SIGN_PROBE_WAIT_SECONDS) {
  console.log(`SIGN_PROBE_WAITING ${process.env.SIGN_PROBE_WAIT_SECONDS}s (context up; the drill pauses the chain now)`);
  await new Promise((r) => setTimeout(r, Number(process.env.SIGN_PROBE_WAIT_SECONDS) * 1_000));
}
let n = 9_001;
try {
  await ctx.signers
    .guarded("authority")!
    .signTypedData(
      {
        domain: registryDomain(cfg.chainId, cfg.addresses.registry),
        types: bindingOpTypes,
        primaryType: "BindingOp",
        message: {
          githubRepoId: BigInt(++n),
          creator: zeroAddress,
          bindingExpiresAt: 4_000_000_000n,
          opDeadline: 4_000_000_000n,
          opNonce: BigInt(n),
          parentOpDigest: `0x${"00".repeat(32)}`,
          repoFullName: "o/r",
          revoke: false,
        },
      },
      { requestedBy: "w08-sign-probe", correlationId: `w08-sign-probe-${n}` },
    );
  console.error("SIGN_PROBE_RESULT=SIGNED (the guard did NOT fail closed)");
  process.exit(1);
} catch (e) {
  const msg = (e as Error).message;
  if (!/fail closed/i.test(msg)) {
    console.error(`SIGN_PROBE_RESULT=UNEXPECTED_REFUSAL: ${msg.split("\n")[0]}`);
    process.exit(1);
  }
  console.log(`SIGN_PROBE_RESULT=REFUSED_FAIL_CLOSED: ${msg.split("\n")[0]}`);
  process.exit(0);
} finally {
  await db.close();
}
