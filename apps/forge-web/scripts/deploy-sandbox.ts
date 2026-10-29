import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { deploySandbox, writeDeployment } from "./sandbox-lib";

const rpc = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8545";
const out = process.env.FORGE_DEPLOYMENT_FILE ?? path.resolve(process.cwd(), ".sandbox", "deployment.json");
// Re-run guard (W08 compose finding): `docker compose start <service>` re-runs
// completed depends_on one-shots, and each such re-run used to redeploy the whole
// contract set and silently swap deployment.json under the live stack — a
// restarted worker then indexed a DIFFERENT factory and skipped every event
// emitted before the restart (caught by the W08 interrupted-claim drill). The
// deployment file lives on the same sandbox volume as the chain it describes, so
// an existing file for this chain IS the stack's deployment: never regenerate it.
if (existsSync(out)) {
  const existing = JSON.parse(readFileSync(out, "utf8")) as { chainId?: number; factory?: string };
  if (existing.factory && String(existing.chainId ?? "") === (process.env.FORGE_CHAIN_ID ?? "")) {
    console.log(`W02 deployment already present at ${out} (chain ${existing.chainId}, factory ${existing.factory}); NOT redeploying (one-shot re-run guard).`);
    process.exit(0);
  }
}
const d = await deploySandbox(rpc);
writeDeployment(d, out);
console.log(`W02 Forge stack deployed to ${rpc} (chain ${d.chainId}); factory ${d.factory}; wrote ${out}`);
