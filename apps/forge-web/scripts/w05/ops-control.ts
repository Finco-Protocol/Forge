/**
 * W05 operator CLI for immediate off-chain controls (audited).
 *
 *   tsx scripts/w05/ops-control.ts lockdown on  --reason "<why>" --operator <id>
 *   tsx scripts/w05/ops-control.ts lockdown off --reason "<why>" --operator <id>
 *   tsx scripts/w05/ops-control.ts status
 *
 * Uses the same configuration (DATABASE_URL / FORGE_PGLITE_DIR) as the app.
 */
import { buildConfig } from "../../src/server/config";
import { openDb } from "../../src/server/db";
import { migrate } from "../../src/server/db/migrate";
import { readControl, setControl } from "../../src/server/ops/controls";

const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const cfg = buildConfig(process.env);
  const db = await openDb(cfg.db);
  try {
    await migrate(db);
    const [cmd, sub] = process.argv.slice(2);
    if (cmd === "status") {
      console.log(JSON.stringify({ emergency_lockdown: await readControl(db, "emergency_lockdown") }, null, 2));
      return;
    }
    if (cmd !== "lockdown" || (sub !== "on" && sub !== "off")) throw new Error("usage: ops-control.ts lockdown on|off --reason <text> --operator <id> | status");
    await setControl(db, "emergency_lockdown", sub === "on", arg("--reason") ?? "", arg("--operator") ?? "");
    console.log(`emergency_lockdown=${sub}`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
