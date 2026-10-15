/**
 * W05 materialized-ledger operator commands (uses the full app config):
 *
 *   tsx scripts/w05/ledger-admin.ts status
 *   tsx scripts/w05/ledger-admin.ts check                 # self-check now (halts on divergence / deficit)
 *   tsx scripts/w05/ledger-admin.ts rebuild               # deterministic rebuild of snapshots from chain_events
 *   tsx scripts/w05/ledger-admin.ts clear-halt <operator> <note...>   # lifts a halt only if a fresh check passes
 */
import { createAppContext } from "../../src/server/context";
import { checkpointName } from "../../src/server/indexer/indexer";
import { clearLedgerHalt, ledgerContextFor, ledgerIntegrity, rebuildSnapshots } from "../../src/server/finance/materialized";
import { ledgerSelfCheck, selfCheckDeps } from "../../src/server/finance/service";

process.env.FORGE_PROCESS_ROLE ??= "cli";
const [cmd, ...rest] = process.argv.slice(2);
const ctx = await createAppContext();
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
let code = 0;
try {
  if (cmd === "status") out(await ledgerIntegrity(ctx.db, ctx.cfg.chainId));
  else if (cmd === "check") {
    const r = await ledgerSelfCheck(ctx);
    out(r);
    code = r.ok ? 0 : 2;
  } else if (cmd === "rebuild") {
    out(await rebuildSnapshots(ctx.db, ctx.cfg.chainId, ledgerContextFor(ctx.cfg.addresses), checkpointName(ctx), ctx.cfg.reorgWindow));
  } else if (cmd === "clear-halt") {
    const [operator, ...note] = rest;
    if (!operator || !note.length) throw new Error("usage: clear-halt <operator> <note...>");
    const r = await clearLedgerHalt(selfCheckDeps(ctx), `operator:${operator}`, note.join(" "));
    out(r);
    code = r.cleared ? 0 : 2;
  } else {
    throw new Error("usage: ledger-admin.ts status | check | rebuild | clear-halt <operator> <note...>");
  }
} catch (e) {
  console.error((e as Error).message);
  code = 1;
} finally {
  await ctx.db.close();
}
process.exit(code);
