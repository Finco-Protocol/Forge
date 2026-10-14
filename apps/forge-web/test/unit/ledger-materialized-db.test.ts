/**
 * W05 materialized ledger against real Postgres SQL (PGlite): snapshots
 * written in the indexer's range transaction, canonical-snapshot selection,
 * reorg rollback, tamper detection, self-check halt and attestor refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { PgliteDb } from "@/server/db";
import { migrate } from "@/server/db/migrate";
import { buildLedger } from "@/server/finance/ledger";
import { ledgerDigest } from "@/server/finance/ledger-fold";
import {
  clearLedgerHalt,
  ledgerIntegrity,
  loadMaterializedLedger,
  loadReferenceLedger,
  rebuildSnapshots,
  runLedgerSelfCheck,
  signingBlockedReason,
  type SelfCheckDeps,
} from "@/server/finance/materialized";
import { syncRevenueAttestations } from "@/server/finance/attestor";
import type { AppContext } from "@/server/context";
import { generateHistory, NATIVE, SYN_CONTEXT } from "../../scripts/w05/synthetic-history";
import { HARNESS_CHECKPOINT, rollbackHarness, seedHistory } from "../../scripts/w05/ledger-db-harness";

const CHAIN = 31337;
let db: PgliteDb;

beforeEach(async () => {
  db = await PgliteDb.open();
  await migrate(db);
}, 60_000);
afterEach(async () => {
  await db.close();
});

const deps = (extra: Partial<SelfCheckDeps> = {}): SelfCheckDeps => ({ db, chainId: CHAIN, ledger: SYN_CONTEXT, checkpointName: HARNESS_CHECKPOINT, ...extra });
const reference = async () => (await loadReferenceLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT)).ledger;

describe("W05 materialized ledger (PGlite)", { timeout: 120_000 }, () => {
  it("snapshots written per indexer range; load = newest canonical snapshot + newer events ≡ buildLedger", async () => {
    const h = generateHistory({ seed: 21, targetEvents: 1500 });
    const seeded = await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 7, snapshotMinBlocks: 20, ctx: SYN_CONTEXT });
    expect(seeded.snapshots).toBeGreaterThan(3);
    const m = await loadMaterializedLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT);
    expect(m.info.source).toBe("snapshot");
    expect(m.checkpoint).toBe(BigInt(h.lastBlock));
    expect(ledgerDigest(m.ledger)).toBe(ledgerDigest(buildLedger(h.events, h.ctx)));
    expect(m.ledger).toEqual(await reference());
    // Retention: snapshots inside the reorg window + one below it.
    const n = (await db.query<{ n: string; lo: string }>("SELECT count(*)::text AS n, min(block_number)::text AS lo FROM ledger_snapshots")).rows[0]!;
    expect(Number(n.n)).toBeLessThanOrEqual(64 / 20 + 3);
  });

  it("reorg: rollback deletes snapshots above the ancestor; the new branch folds from the surviving snapshot", async () => {
    const a = generateHistory({ seed: 33, targetEvents: 1200 });
    const fork = Math.floor(a.lastBlock * 0.6);
    const b = generateHistory({ seed: 33, targetEvents: 1300, fork: { block: fork, salt: "b" } });
    await seedHistory(db, a, { chainId: CHAIN, rangeBlocks: 5, snapshotMinBlocks: 10, ctx: SYN_CONTEXT });
    await rollbackHarness(db, CHAIN, fork, a.blockHashes.get(fork)!);
    const above = (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_snapshots WHERE block_number > $1", [fork])).rows[0]!.n;
    expect(above).toBe("0");
    await seedHistory(db, b, { chainId: CHAIN, rangeBlocks: 5, snapshotMinBlocks: 10, fromBlock: fork, ctx: SYN_CONTEXT });
    const m = await loadMaterializedLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT);
    expect(m.ledger).toEqual(buildLedger(b.events, b.ctx));
    expect((await runLedgerSelfCheck(deps())).ok).toBe(true);
  });

  it("a snapshot whose block hash is no longer canonical is ignored even if a rollback missed it", async () => {
    const h = generateHistory({ seed: 8, targetEvents: 600 });
    await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 10, snapshotMinBlocks: 10, ctx: SYN_CONTEXT });
    const top = (await db.query<{ b: string }>("SELECT max(block_number)::text AS b FROM ledger_snapshots")).rows[0]!.b;
    await db.query("UPDATE indexed_blocks SET block_hash = '0xreorged' WHERE block_number = $1", [top]);
    const m = await loadMaterializedLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT);
    expect(m.info.snapshotBlock).not.toBe(top);
    expect(m.ledger).toEqual(await reference());
  });

  it("tampered snapshot (checksum) or changed history below a snapshot → not used, genesis fold instead", async () => {
    const h = generateHistory({ seed: 9, targetEvents: 500 });
    await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 10, snapshotMinBlocks: 1, ctx: SYN_CONTEXT });
    await db.query("UPDATE ledger_snapshots SET state = replace(state, '\"curveSweeps\":1', '\"curveSweeps\":9')");
    let m = await loadMaterializedLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT);
    expect(m.info.source).toBe("genesis");
    expect(m.info.fallbackReason).toMatch(/checksum/);
    expect(m.ledger).toEqual(await reference());
    await rebuildSnapshots(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT, 64);
    await db.query("DELETE FROM chain_events WHERE ctid = (SELECT ctid FROM chain_events ORDER BY block_number LIMIT 1)");
    m = await loadMaterializedLedger(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT);
    expect(m.info.fallbackReason).toMatch(/covers \d+ events/);
    expect(m.ledger).toEqual(await reference());
  });

  it("self-check passes on a healthy cache; a divergent cache HALTS, alerts, blocks the attestor, and a halt clears only after rebuild", async () => {
    const h = generateHistory({ seed: 12, targetEvents: 800 });
    await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 10, snapshotMinBlocks: 1, ctx: SYN_CONTEXT });
    expect(await signingBlockedReason(db, CHAIN)).toMatch(/UNVERIFIED/);
    const ok = await runLedgerSelfCheck(deps());
    expect(ok.ok).toBe(true);
    expect(ok.source).toBe("snapshot");
    expect(ok.materializedDigest).toBe(ok.referenceDigest);
    expect(await signingBlockedReason(db, CHAIN)).toBeNull();

    // Corrupt the newest snapshot consistently (checksum recomputed): only the self-check can notice.
    const row = (await db.query<{ block_number: string; state: string }>("SELECT block_number::text, state FROM ledger_snapshots ORDER BY block_number DESC LIMIT 1")).rows[0]!;
    const forged = row.state.replace(/"protocolCredited":\{"\$b":"(\d+)"\}/, (_m, v: string) => `"protocolCredited":{"$b":"${BigInt(v) + 1n}"}`);
    expect(forged).not.toBe(row.state);
    const { sha256Hex } = await import("@/server/finance/ledger-fold");
    await db.query("UPDATE ledger_snapshots SET state = $2, state_sha256 = $3 WHERE block_number = $1", [row.block_number, forged, sha256Hex(forged)]);
    const bad = await runLedgerSelfCheck(deps());
    expect(bad.ok).toBe(false);
    expect(bad.halted).toBe(true);
    expect(bad.problems).toContain("MATERIALIZED_LEDGER_DIVERGENCE");
    const i = await ledgerIntegrity(db, CHAIN);
    expect(i!.halted).toBe(true);
    expect(await signingBlockedReason(db, CHAIN)).toMatch(/LEDGER_HALTED/);
    const alerts = await db.query<{ action: string }>("SELECT action FROM audit_events WHERE action = 'ALERT:ledger_halted'");
    expect(alerts.rows.length).toBe(1);

    // The attestor refuses before touching the chain.
    const fakeCtx = {
      db,
      cfg: { chainId: CHAIN, addresses: { revenueSplitter: SYN_CONTEXT.splitter, feeEscrow: SYN_CONTEXT.escrow, factory: SYN_CONTEXT.factory } },
      revenueAttestor: { address: "0x00000000000000000000000000000000000000aa" },
      client: new Proxy({}, { get: () => () => Promise.reject(new Error("chain must not be read while halted")) }),
    } as unknown as AppContext;
    const out = await syncRevenueAttestations(fakeCtx, async () => ({ ledger: await reference(), checkpoint: 1n }), async () => new Set<Address>());
    expect(out).toEqual([{ asset: null, status: "LEDGER_HALTED", reason: expect.stringMatching(/MATERIALIZED_LEDGER_DIVERGENCE/) }]);

    // Clearing is refused while the divergence persists; succeeds after a deterministic rebuild.
    expect((await clearLedgerHalt(deps(), "operator:test", "attempt 1")).cleared).toBe(false);
    expect((await ledgerIntegrity(db, CHAIN))!.halted).toBe(true);
    await rebuildSnapshots(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT, 64);
    const cleared = await clearLedgerHalt(deps(), "operator:test", "rebuilt from chain_events");
    expect(cleared.cleared).toBe(true);
    expect(await signingBlockedReason(db, CHAIN)).toBeNull();
  });

  it("an unexplained splitter deficit (reconcile deficit > 0) halts; an RPC failure fails the check without halting", async () => {
    const h = generateHistory({ seed: 14, targetEvents: 400 });
    await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 10, snapshotMinBlocks: 1, ctx: SYN_CONTEXT });
    const rpcDown = await runLedgerSelfCheck(deps({ readDeficits: () => Promise.reject(new Error("rpc down")) }));
    expect(rpcDown.ok).toBe(false);
    expect(rpcDown.halted).toBe(false);
    expect(await signingBlockedReason(db, CHAIN)).toMatch(/did not pass/);
    const zero = await runLedgerSelfCheck(deps({ readDeficits: async (assets) => new Map(assets.map((a) => [a, 0n])) }));
    expect(zero.ok).toBe(true);
    const deficit = await runLedgerSelfCheck(deps({ readDeficits: async (assets) => new Map(assets.map((a) => [a, a === NATIVE ? 7n : 0n])) }));
    expect(deficit.halted).toBe(true);
    expect(deficit.deficits).toEqual([{ asset: NATIVE, deficit: "7" }]);
    expect((await ledgerIntegrity(db, CHAIN))!.haltReason).toMatch(/SPLITTER_DEFICIT/);
  });

  it("deterministic rebuild from full history reproduces the same digest as incremental materialization", async () => {
    const h = generateHistory({ seed: 15, targetEvents: 900 });
    await seedHistory(db, h, { chainId: CHAIN, rangeBlocks: 3, snapshotMinBlocks: 4, ctx: SYN_CONTEXT });
    // Every incrementally written snapshot digest = reference over the events up to its block.
    const snaps = (await db.query<{ block_number: string; ledger_digest: string }>("SELECT block_number::text, ledger_digest FROM ledger_snapshots ORDER BY block_number")).rows;
    expect(snaps.length).toBeGreaterThan(2);
    for (const sn of snaps) expect(sn.ledger_digest).toBe(ledgerDigest(buildLedger(h.events.filter((e) => e.blockNumber <= BigInt(sn.block_number)), h.ctx)));
    const r = await rebuildSnapshots(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT, 64);
    expect(r.written).toBe(true);
    expect(r.digest).toBe(ledgerDigest(buildLedger(h.events, h.ctx)));
    const again = await rebuildSnapshots(db, CHAIN, SYN_CONTEXT, HARNESS_CHECKPOINT, 64);
    expect(again.digest).toBe(r.digest);
  });
});
