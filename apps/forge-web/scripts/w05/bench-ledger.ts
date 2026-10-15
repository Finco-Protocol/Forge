/**
 * W05 ledger benchmark: full rebuild (buildLedger) vs incremental apply vs
 * DB snapshot load, on synthetic histories (scripts/w05/synthetic-history.ts).
 *
 *   tsx scripts/w05/bench-ledger.ts [--sizes 1000,10000,100000] [--reps 5] [--tail 100] [--pg URL] [--json out.json]
 *
 * Every figure is a wall-clock measurement (performance.now) of this run;
 * median/min/max over --reps. With --pg, the DB columns and migration time
 * are measured on that PostgreSQL server in scratch databases.
 */
import os from "node:os";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { buildLedger, type LedgerEvent } from "../../src/server/finance/ledger";
import { applyEvents, decodeFoldState, encodeFoldState, finalizeFold, foldAll, ledgerDigest } from "../../src/server/finance/ledger-fold";
import { PgDb } from "../../src/server/db";
import { migrate } from "../../src/server/db/migrate";
import { loadMaterializedLedger, loadReferenceLedger } from "../../src/server/finance/materialized";
import { createDatabaseSql, dropDatabaseSql } from "./sql-ident";
import { generateHistory, SYN_CONTEXT } from "./synthetic-history";
import { HARNESS_CHECKPOINT, seedHistory } from "./ledger-db-harness";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sizes = (arg("sizes", "1000,10000,100000") as string).split(",").map(Number);
const reps = Number(arg("reps", "5"));
const tail = Number(arg("tail", "100"));
const pgUrl = arg("pg");
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s[s.length - 1]! };
};
const time = async <T>(fn: () => T | Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};

const env = {
  os: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`,
  memGB: Math.round(os.totalmem() / 2 ** 30),
  node: process.version,
  postgres: null as string | null,
  date: new Date().toISOString(),
};
const rows: Record<string, unknown>[] = [];
let admin: pg.Client | null = null;
if (pgUrl) {
  admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  env.postgres = (await admin.query("SHOW server_version")).rows[0].server_version;
}

for (const n of sizes) {
  const [h, genMs] = await time(() => generateHistory({ seed: 424242, targetEvents: n }));
  const events: LedgerEvent[] = h.events;
  const cutBlock = BigInt(h.events[Math.max(0, events.length - tail) ]!.blockNumber) - 1n;
  const head = events.filter((e) => e.blockNumber <= cutBlock);
  const newer = events.filter((e) => e.blockNumber > cutBlock);
  const full: number[] = [], foldFull: number[] = [], inc: number[] = [], dec: number[] = [], enc: number[] = [];
  let digest = "";
  const baseState = foldAll(head, SYN_CONTEXT, cutBlock);
  const snapText = encodeFoldState(baseState);
  for (let r = 0; r < reps; r++) {
    const [l1, t1] = await time(() => buildLedger(events, SYN_CONTEXT));
    full.push(t1);
    const [, t2] = await time(() => foldAll(events, SYN_CONTEXT));
    foldFull.push(t2);
    const [st, t3] = await time(() => decodeFoldState(snapText));
    dec.push(t3);
    const [, t4] = await time(() => applyEvents(st, newer, SYN_CONTEXT, BigInt(h.lastBlock)));
    inc.push(t4);
    const [, t5] = await time(() => encodeFoldState(st));
    enc.push(t5);
    digest = ledgerDigest(l1);
    if (ledgerDigest(finalizeFold(st)) !== digest) throw new Error("incremental != full: benchmark invalid");
  }
  const row: Record<string, unknown> = {
    events: events.length, blocks: h.lastBlock, tailEvents: newer.length, snapshotBytes: snapText.length, reps,
    buildLedger_ms: stats(full), foldFromGenesis_ms: stats(foldFull), snapshotDecode_ms: stats(dec), applyTail_ms: stats(inc), snapshotEncode_ms: stats(enc),
    incrementalTotal_ms: stats(dec.map((d, i) => d + inc[i]!)), digest: digest.slice(0, 16), generate_ms: Math.round(genMs),
  };
  if (admin && pgUrl) {
    const name = `forge_bench_${n}_${process.pid}`;
    await admin.query(createDatabaseSql(name));
    const u = new URL(pgUrl); u.pathname = `/${name}`;
    const db = new PgDb(u.toString(), { max: 4, applicationName: "forge-bench", statementTimeoutMs: 0 });
    try {
      const [, migMs] = await time(() => migrate(db));
      const [seed, seedMs] = await time(() => seedHistory(db, h, { chainId: 31337, rangeBlocks: 50, snapshotMinBlocks: Math.max(20, Math.floor(h.lastBlock / 40)), ctx: SYN_CONTEXT }));
      const dbFull: number[] = [], dbMat: number[] = [];
      let source = "";
      for (let r = 0; r < reps; r++) {
        const [, a] = await time(() => loadReferenceLedger(db, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT));
        dbFull.push(a);
        const [m, b] = await time(() => loadMaterializedLedger(db, 31337, SYN_CONTEXT, HARNESS_CHECKPOINT));
        dbMat.push(b);
        source = `${m.info.source}@${m.info.snapshotBlock} +${m.info.appliedEvents} events`;
        if (ledgerDigest(m.ledger) !== digest) throw new Error("DB materialized != reference: benchmark invalid");
      }
      const sz = (await db.query<{ s: string; n: string }>("SELECT pg_total_relation_size('ledger_snapshots')::text AS s, (SELECT count(*) FROM ledger_snapshots)::text AS n")).rows[0]!;
      Object.assign(row, {
        pg_migrateAll_ms: Math.round(migMs), pg_seed_ms: Math.round(seedMs), pg_ranges: seed.ranges, pg_snapshotsWritten: seed.snapshots,
        pg_rangeCommitWithSnapshot_ms: stats(seed.ms), pg_loadReference_ms: stats(dbFull), pg_loadMaterialized_ms: stats(dbMat),
        pg_materializedSource: source, pg_snapshotTableBytes: Number(sz.s), pg_snapshotRows: Number(sz.n),
      });
    } finally {
      await db.close();
      await admin.query(dropDatabaseSql(name));
    }
  }
  rows.push(row);
  console.error(`done ${n}`);
}
if (admin) {
  // Migration time on an empty database, repeated.
  const ms: number[] = [];
  for (let r = 0; r < reps; r++) {
    const name = `forge_bench_mig_${process.pid}_${r}`;
    await admin.query(createDatabaseSql(name));
    const u = new URL(pgUrl!); u.pathname = `/${name}`;
    const db = new PgDb(u.toString(), { max: 2, applicationName: "forge-bench", statementTimeoutMs: 0 });
    try {
      ms.push((await time(() => migrate(db)))[1]);
    } finally {
      await db.close();
      await admin.query(dropDatabaseSql(name));
    }
  }
  (env as Record<string, unknown>).migrationEmptyDb_ms = stats(ms);
  await admin.end();
}
const result = { env, params: { sizes, reps, tail }, rows };
const out = arg("json");
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
