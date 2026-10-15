/**
 * W06 staging operator CLI (no network writes, no cloud SDK).
 *
 *   tsx scripts/w06/staging-ops.ts manifest [out.json]        write the versioned build manifest
 *   tsx scripts/w06/staging-ops.ts verify <manifest.json>     re-derive and compare (exit 1 on drift/tamper)
 *   tsx scripts/w06/staging-ops.ts check-env                  validate process.env with the staging guard (exit 1 = refused)
 *   tsx scripts/w06/staging-ops.ts snapshot <out.dump>        pg_dump -Fc of DATABASE_URL + sidecar digest JSON
 *   tsx scripts/w06/staging-ops.ts rollback-plan <manifest>   can the DB run the target (older) build? (no down migrations)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { stagingViolations } from "../../src/server/staging/guard";
import { PgDb } from "../../src/server/db";
import { backupDatabase, buildManifest, digestDatabase, rollbackPlan, verifyManifest, type StagingManifest } from "./staging-lib";

const [cmd, arg] = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
let code = 0;
try {
  if (cmd === "manifest") {
    const m = buildManifest();
    if (arg) writeFileSync(arg, JSON.stringify(m, null, 2) + "\n");
    out(m);
  } else if (cmd === "verify") {
    if (!arg) throw new Error("usage: verify <manifest.json>");
    const problems = verifyManifest(JSON.parse(readFileSync(arg, "utf8")) as StagingManifest);
    out({ ok: problems.length === 0, problems });
    code = problems.length ? 1 : 0;
  } else if (cmd === "check-env") {
    const v = stagingViolations(process.env);
    out({ ok: v.length === 0, violations: v });
    code = v.length ? 1 : 0;
  } else if (cmd === "snapshot") {
    if (!arg || !process.env.DATABASE_URL) throw new Error("usage: DATABASE_URL=… snapshot <out.dump>");
    backupDatabase(process.env.DATABASE_URL, arg);
    const d = await digestDatabase(process.env.DATABASE_URL, process.env);
    writeFileSync(`${arg}.digest.json`, JSON.stringify({ ...d, manifestDigest: buildManifest().digest }, null, 2) + "\n");
    out({ dump: arg, ledgerDigest: d.ledgerDigest, materializedDigest: d.materializedDigest });
  } else if (cmd === "rollback-plan") {
    if (!arg || !process.env.DATABASE_URL) throw new Error("usage: DATABASE_URL=… rollback-plan <target-manifest.json>");
    const db = new PgDb(process.env.DATABASE_URL, { max: 2, applicationName: "forge-cli" });
    const plan = await rollbackPlan(db, JSON.parse(readFileSync(arg, "utf8")) as StagingManifest);
    await db.close();
    out(plan);
    code = plan.safe ? 0 : 2;
  } else {
    throw new Error("usage: manifest | verify | check-env | snapshot | rollback-plan");
  }
} catch (e) {
  console.error((e as Error).message);
  code = 1;
}
process.exit(code);
