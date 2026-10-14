# W05 — Database & materialized ledger

Scope: PostgreSQL production mode, migration policy, backup/restore rehearsal, worker isolation, and the materialized financial ledger.
Flags unchanged: `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`. No Solidity changed.

## 1. Production DB mode

`DATABASE_URL` selects PostgreSQL (`pg`); without it PGlite is used (sandbox/tests, same SQL).

| Env | Default | Meaning |
|---|---|---|
| `FORGE_PROCESS_ROLE` | `web` (`worker` for `scripts/worker.ts`, `cli` for admin scripts) | `application_name = forge-<role>` in `pg_stat_activity` |
| `FORGE_DB_POOL_MAX` | 10 | max connections **per process** |
| `FORGE_DB_IDLE_TIMEOUT_MS` | 30000 | idle connection reap |
| `FORGE_DB_CONNECT_TIMEOUT_MS` | 5000 | fail fast when the server is unreachable |
| `FORGE_DB_STATEMENT_TIMEOUT_MS` | 30000 | server-side `statement_timeout` (migrations lift it with `SET LOCAL`) |
| `FORGE_DB_IDLE_IN_TX_TIMEOUT_MS` | 60000 | `idle_in_transaction_session_timeout` |
| `FORGE_DB_MIGRATE` | `apply` | `verify`: never migrate, only check the schema (use when a dedicated migrator job runs `pnpm db:migrate`) |
| `FORGE_DB_MIGRATION_LOCK_TIMEOUT_MS` | 120000 | wait for the migration advisory lock |

**Pool sizing.** Total server connections = Σ over processes of `FORGE_DB_POOL_MAX` (+ one dedicated connection while a process holds a session advisory lock: migrations, indexer leadership, attestor). Keep the sum below `max_connections` minus headroom for admin/backup. Worker needs few (pool 3–5 is enough: one pass is sequential; the indexer leader and attestor each pin one); web scales with request concurrency. Behind PgBouncer, **session** pooling is required (session advisory locks); transaction pooling breaks leader locks.

**Startup checks (`assertDatabaseReady`, fail closed, one error listing all failures):** server >= 14; session `TimeZone` is UTC (pool forces `-c TimeZone=UTC`; a raw session with another zone is refused); extension `plpgsql` present (the only extension the schema needs: immutability triggers; nothing else is required); schema exactly at the code's migration version (no pending/drifted/unknown migrations).

**Health (`GET /api/health`)** now also returns `db` (round-trip latency, pool stats, migration version/pending/drift/unknown), `indexer` (checkpoint, head, lag vs finality-safe head, checkpoint age), `worker` (live heartbeats, state, passes, last error; `ok=false` when no heartbeat within `FORGE_WORKER_HEARTBEAT_STALE_SECONDS`, default 120), `ledger` (mode, halted flag and reason, last self-check, latest snapshot). Top-level `ok` = chain reachable AND db ok AND ledger not halted. Worker `ok=false` is reported but does not flip `ok` (web can run without a worker, e.g. in tests); alert on it.

## 2. Migration policy and rollback

- Files `NNN_name.sql`, lexical order, each applied in its own transaction, under `pg_advisory_lock` (`schema-migrations`) so concurrent web+worker starts serialize; the loser sees the work done and applies nothing.
- `schema_migrations.checksum` = sha256 of the file (CRLF-normalised). Startup **fails** if an applied file's checksum differs (`MIGRATION_DRIFT`) or if the DB has a migration the code lacks (`MIGRATION_UNKNOWN`, i.e. an older build against a newer schema). Both are checked before anything is applied. Rows from before W05 have no checksum and adopt the current file's once (trust on first use; `checksum_adopted_at` records it).
- **Rollback strategy: forward-only.** No down migrations. Migrations must be additive and backward compatible with the previous release for one deploy (expand → deploy → contract in a later migration). To undo a bad migration: ship a new forward migration, or restore from backup (section 3) and redeploy the previous build. Deploying an older build against a newer schema is refused by design.
- Note: numbering skips `004` on purpose (`005_ledger_materialization.sql` was assigned by the W05 plan; 004 is reserved for a sibling workstream). Ordering is by name, so a later-merged 004 would be pending on DBs that already applied 005; it applies normally (additive migrations only).
- `005` is additive: `ledger_snapshots`, `ledger_integrity`, `worker_heartbeats`. Dropping them loses only derived/operational data.

## 3. Backup / restore rehearsal

`pnpm db:backup-rehearsal` (`scripts/w05/db-backup-rehearsal.ts`; env `FORGE_REHEARSAL_ADMIN_URL`): scratch DB -> migrate -> seed 20,000 synthetic events through the indexer-shaped write path (with snapshots) -> row counts of every table + reference and materialized ledger digests -> `pg_dump -Fc` -> `pg_restore --exit-on-error` into a fresh DB -> compare counts, migration checksums, both digests, run startup checks. Environment: PostgreSQL 16.15 (Ubuntu), local, same host. Raw output of the run (also `docs/evidence/w05-backup-rehearsal.txt`):

```
[rehearsal] server 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1); pg_dump pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
[rehearsal] seeded 20001 events, 313 ranges, 156 snapshots (44816 ms)
[rehearsal] pg_dump -Fc -> 3230645 bytes (46037 ms)
[rehearsal] pg_restore into fresh database complete (46858 ms)
[rehearsal] PASS rows attestations 0 == 0
[rehearsal] PASS rows audit_events 1 == 1
[rehearsal] PASS rows chain_events 20001 == 20001
[rehearsal] PASS rows evidence_receipts 0 == 0
[rehearsal] PASS rows fin_claim_submissions 0 == 0
[rehearsal] PASS rows github_users 0 == 0
[rehearsal] PASS rows indexed_blocks 6628 == 6628
[rehearsal] PASS rows indexer_checkpoints 1 == 1
[rehearsal] PASS rows installations 0 == 0
[rehearsal] PASS rows jobs 50 == 50
[rehearsal] PASS rows launch_drafts 0 == 0
[rehearsal] PASS rows launch_intents 0 == 0
[rehearsal] PASS rows ledger_integrity 0 == 0
[rehearsal] PASS rows ledger_snapshots 3 == 3
[rehearsal] PASS rows oauth_states 0 == 0
[rehearsal] PASS rows rate_limits 0 == 0
[rehearsal] PASS rows registry_ops 0 == 0
[rehearsal] PASS rows repositories 0 == 0
[rehearsal] PASS rows repository_names 0 == 0
[rehearsal] PASS rows schema_migrations 4 == 4
[rehearsal] PASS rows sessions 0 == 0
[rehearsal] PASS rows signing_requests 0 == 0
[rehearsal] PASS rows tokens 0 == 0
[rehearsal] PASS rows verifications 0 == 0
[rehearsal] PASS rows wallet_bindings 0 == 0
[rehearsal] PASS rows wallet_challenges 0 == 0
[rehearsal] PASS rows webhook_deliveries 0 == 0
[rehearsal] PASS rows worker_heartbeats 0 == 0
[rehearsal] PASS migration versions + checksums 4 migrations, version 005_ledger_materialization.sql
[rehearsal] PASS reference ledger digest 9746e455e25d1b075f644a62d553db723450646bc9e3d105d67b100cde016911
[rehearsal] PASS materialized ledger digest (restored snapshots) snapshot@7775
[rehearsal] PASS startup checks on restored DB PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), TimeZone UTC
[rehearsal] total 47665 ms; 28 tables, 20001 chain_events
[rehearsal] RESULT: OK
```

Production runbook: nightly `pg_dump -Fc` (or physical backups + WAL archiving for PITR), restore to a scratch instance weekly with this script's checks, keep >= 7 daily dumps. After any restore, run `pnpm ledger:check`; the snapshot cache is disposable (`pnpm ledger:rebuild`). The restored DB's indexer resumes from the restored checkpoint and re-indexes the gap from chain (idempotent inserts).

## 4. Worker isolation and shutdown

- **Job claiming:** `claimJobs` = `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`. W05 finding (proved by a regression test on real Postgres): `SKIP LOCKED` only protects *inside the claim statement*; the pre-W05 claim left the row `pending` and visible as soon as it committed, so a second worker could claim an in-flight job. Fix: the claim also pushes `run_after` forward by a **lease** (`FORGE_JOB_LEASE_SECONDS`, default 120); the outcome update rewrites `run_after`/status; a crashed worker's job reappears when the lease expires. Jobs longer than the lease could be duplicated — job handlers are idempotent (W03), and the lease should exceed the slowest job.
- **Indexer:** one leader per checkpoint via session `pg_try_advisory_lock` (non-leaders return `skipped: not_leader`). Independently, the range commit and the reorg rollback `SELECT ... FOR UPDATE` the checkpoint row and abort (`skipped: checkpoint_moved`) unless it is still the (block, hash) the range was computed from, so even with the lock disabled no range commits twice and the checkpoint never moves backwards. Events/blocks/checkpoint/projections/ledger snapshot commit in one transaction.
- **Revenue attestor:** `pg_try_advisory_lock` per chain, so two workers never race the nonce.
- **Graceful shutdown:** `startWorkerLoop` returns a handle; `stop()` prevents new passes, makes the current pass stop picking new indexer ranges, writes heartbeat `stopped`, resolves when the loop exits. `scripts/worker.ts` on SIGTERM/SIGINT: stop -> close pool -> exit 0; second signal or `FORGE_WORKER_SHUTDOWN_GRACE_MS` (60 s) exits 1. A pass in progress is finished (revocation jobs in flight are not abandoned); a hard kill is safe (idempotent steps) but delays its leased jobs until lease expiry.
- **Heartbeat:** `worker_heartbeats` row per worker process, updated each pass (`beat_at`, `passes`, `last_pass_ms`, `last_error`).
- Tested with 4 worker pools over 600 jobs (each processed exactly once), 3-4 concurrent indexers on the real contracts (ranges disjoint and contiguous, no duplicate events, materialized ledger equals reference), two worker loops stopped gracefully, and a real `scripts/worker.ts` child receiving SIGTERM.

## 5. Materialized ledger design

`chain_events` (W03 indexer) remains the only source of truth. `buildLedger` (ledger.ts) is unchanged except that helpers became exported; it is the reference implementation.

- `ledger-fold.ts`: `applyEvents(state, events, ctx, throughBlock)` is the same fold made resumable (state = ledger + curve/pool maps + tax accumulators + deferred exceptions + cursor). `finalizeFold(state)` returns the Ledger.
- `ledger_snapshots(chain_id, context_key, block_number, block_hash, fold_version, event_count, state, state_sha256, ledger_digest)`; `context_key` = hash of fold version + ledger addresses, so a rewired deployment ignores old snapshots. Written by the indexer **in the range's transaction** (inside a SAVEPOINT: a snapshot failure can only make reads slower, never abort indexing), at most one per `FORGE_LEDGER_SNAPSHOT_MIN_BLOCKS` (16) blocks, retaining the reorg window plus the newest older one.
- Read path (`loadFoldAt`, one REPEATABLE READ transaction): newest snapshot `<= checkpoint` whose `(block_number, block_hash)` is still in `indexed_blocks` (canonical) -> verify sha256 and that `count(chain_events <= block)` equals the snapshot's `event_count` -> apply only newer events. Any failed check falls back to a single-batch fold from genesis (= `buildLedger` semantics) and the reason is reported in `info.fallbackReason`.
- Reorg: `rollbackTo` deletes snapshots above the ancestor in its transaction; independently a snapshot whose hash is not canonical is never selected.
- `FORGE_LEDGER_MODE=full` forces `buildLedger` over all events. A halted ledger also forces it.
- Commands: `pnpm ledger:rebuild` (deterministic rebuild from full history), `pnpm ledger:check`, `tsx scripts/w05/ledger-admin.ts status | clear-halt <operator> <note>`.
- Snapshot prefix identity: a snapshot at block B stores the digest of the ledger over events `<= B`; tests assert each stored digest equals `buildLedger` over that prefix.

### Equivalence argument and tests

`buildLedger`: canonicalize (dedupe by blockHash:logIndex, sort), pass 1 maps curve->token and pool->token over the *whole* history, pass 2 folds in order, looking backwards except through the pass-1 maps. The fold runs pass 1 per batch before pass 2 of that batch, so it is identical whenever no earlier batch referenced an identifier that a later batch announces. On chain a curve cannot emit before its launch tx, but the code does not assume it: every unresolved identifier is remembered and a later announcement throws `NonIncrementalHistoryError`, upon which the caller folds from genesis in one batch. Escrow credits pair with a sweep of the same tx (same block), so batches are whole blocks; unmatched-credit exceptions are emitted per batch end, matching buildLedger's final position. Re-delivered events at or below the cursor are ignored.

Evidence (`test/unit/ledger-fold.test.ts`, 10 tests; generator `scripts/w05/synthetic-history.ts` covers launches, native + ERC-20 quote assets, curve buys/sells with tax, snipe tax, buyback locks, curve and hook sweeps incl. unsplit conversion and `PoolConversionSkipped`, vault locks/releases, owner rescues, third-party credits and claims, splitter authorizations/allocations/non-revenue/treasury claims, governance events, unmatched/mismatched credits, empty blocks):
- 30 random seeds x random cut points (2-27 cuts), each batch delivered duplicated, shuffled and with earlier events re-delivered, state serialized/restored at every cut: `toEqual` and digest equal `buildLedger(all)`; plus every-block cut.
- Reorg: for 15 seeds an alternative branch (same prefix, different hashes/events after the fork) — restoring the newest pre-fork snapshot and applying the new branch equals `buildLedger(new branch)`; the test also shows a stale post-fork snapshot would give a different digest (the canonical-hash guard is necessary).
- Asset/launch isolation and no duplicate fee recognition checked against independently computed sums from the raw events.
- Mutation check performed manually: removing re-delivery skipping, tax-accumulator reset, deferred-exception ordering, the forward-reference guard, or the conversion-skipped rule each made the suite fail (5-7 of 10 tests; 1 for the guard).
- `test/unit/ledger-materialized-db.test.ts` (7 tests, PGlite): DB write path, reorg rollback, non-canonical snapshot ignored, checksum/event-count tamper fallback, halt/alert/attestor refusal, deficit halt, deterministic rebuild.

## 6. Halt conditions (fail closed)

`runLedgerSelfCheck` (worker, at most every `FORGE_LEDGER_SELF_CHECK_INTERVAL_MS`, default 10 min, and before the attestor's first signature at each evidence block) compares digests of: materialized ledger, `buildLedger` over all events, and a genesis fold. It then reads the splitter's `reconcile(asset)` at the checkpoint block. HALT (sticky `ledger_integrity.halted`, audit row `ALERT:ledger_halted`) on: materialized != reference, fold != reference, or any reconcile `deficit > 0`. While halted: `loadLedger` serves the reference rebuild, `syncRevenueAttestations` returns `LEDGER_HALTED` and signs nothing. If the check cannot complete (RPC failure) it records a failed check: signing is blocked (`LEDGER_INTEGRITY_UNVERIFIED`) but nothing is halted. Clearing requires an operator running `clear-halt`, which re-runs the check and lifts the flag only if it passes (audited). Splitter surplus is not a halt condition (already surfaced as an exception).

## 7. Benchmarks (measured)

Environment: Linux 6.18.44-fc-v114 x64; Intel(R) Xeon(R) Processor @ 2.80GHz x4; 16 GB RAM; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on the same host (loopback, default config, `fsync` on); run 2026-10-14T20:24:44.350Z. Command: `pnpm bench:ledger --sizes 1000,10000,100000 --reps 5 --pg <url> --json docs/evidence/w05-bench-ledger.json`. Synthetic data (seed 424242), single process, one run per size, 5 repetitions, median shown (min/max in the JSON). Incremental columns cover a tail of ~100 events on top of a snapshot. All results were cross-checked: incremental digest == full digest, DB materialized digest == reference digest.

| events | blocks | snapshot JSON | buildLedger (ref) | fold genesis | snapshot decode | apply tail (~100 ev) | decode+tail | PG load reference | PG load materialized | PG range commit incl. snapshot |
|---|---|---|---|---|---|---|---|---|---|---|
| 1002 | 288 | 0.25 MB | 8.8 ms | 7.0 ms | 11.4 ms | 1.1 ms | 12.2 ms | 22.1 ms | 24.1 ms | 61.6 ms |
| 10000 | 3774 | 1.78 MB | 51.6 ms | 65.3 ms | 57.0 ms | 0.7 ms | 57.9 ms | 131.3 ms | 75.6 ms | 40.0 ms |
| 100005 | 40060 | 15.53 MB | 679.0 ms | 750.8 ms | 708.0 ms | 0.9 ms | 708.9 ms | 1929.5 ms | 894.1 ms | 65.2 ms |

- 1002 events: all migrations on empty DB, one pool: 288 ms; snapshot table 3 rows, 0.3 MB on disk
- 10000 events: all migrations on empty DB, one pool: 424 ms; snapshot table 2 rows, 10.9 MB on disk
- 100005 events: all migrations on empty DB, one pool: 239 ms; snapshot table 2 rows, 56.3 MB on disk
- Migrations on an empty DB (all 4 files, 5 reps): median 222 ms (min 160, max 331). 6 pools migrating concurrently: 269 ms in the pg test (one run).

**Reading the numbers honestly.** Applying the tail is O(new events) (about 1 ms regardless of history). But the ledger *state* is itself O(events) (it keeps every credit/claim/governance row, because the API serves them), so a snapshot is as large as the history (about 155 bytes/event of JSON) and decoding it costs about as much as re-folding in memory (100k events: decode 708 ms vs fold 751 ms vs `buildLedger` 679 ms). The measured end-to-end DB win is therefore modest: 1k events none (24 vs 22 ms), 10k 1.7x (76 vs 131 ms), 100k 2.2x (894 vs 1930 ms), mostly from avoiding the row fetch/parse of every `chain_events` row, not from avoiding the fold. This is not constant-time per request. See limits.

## 8. Limits

- Snapshot size and load time are linear in history (about 15.5 MB per 100k events); per-request cost remains O(events) in decode. A real fix needs aggregate-only state plus paginated row tables (a larger redesign); not done. An in-process cache keyed by (checkpoint block, hash) would remove the decode on repeated requests; not implemented.
- Benchmarks are synthetic, single host, loopback Postgres, one run; they are not production capacity numbers.
- The fold refuses (falls back to full) histories where an identifier is used before it is announced; such a fallback is correct but not fast.
- Self-check cost is a full rebuild (about 1 s at 100k events), run every 10 min by default.
- Job lease must exceed the longest job or the job may run twice (handlers are idempotent).
- The migration lock and leader locks need session-mode pooling (not PgBouncer transaction mode).
- The indexer must run against a primary (advisory locks are not replicated).
- Migration checksum adoption for pre-W05 rows is trust-on-first-use.
- Rehearsal ran on a local scratch server with synthetic data, not on production-sized data or object storage.
- Worker liveness is by heartbeat age only; no automatic restart or paging is wired up.

## 9. Running the PostgreSQL tests

`FORGE_TEST_DATABASE_URL=postgres://user@host:5432/postgres pnpm test:pg` (creates and drops its own databases). `FORGE_TEST_REQUIRE_PG=1` makes the suite fail instead of skip when the URL is missing; with the URL set, an unreachable server fails loudly.
