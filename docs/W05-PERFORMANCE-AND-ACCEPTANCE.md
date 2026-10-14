# W05 — Measured performance and acceptance evidence

All figures are **sandbox measurements** (Linux x64, 4 vCPU Xeon 2.8 GHz, Node 22, PGlite, local Anvil automine, in-process fake GitHub, local-test signer — no KMS, no real RPC/GitHub latency, concurrency 1, 10 launches × 10 repetitions). They are not production SLOs. Raw data: `docs/evidence/w05-bench-platform.json`, `w05-bench-ledger.json`, `w05-backup-rehearsal.txt`; regenerate with `pnpm bench:platform`, `pnpm bench:ledger`.

| Operation | Median | p95 |
|---|---|---|
| Repository verification | 18.3 ms | 55.8 ms |
| Launch draft create | 24.8 ms | 42.4 ms |
| Launch authorize (policy + local signature) | 275.1 ms | 322.5 ms |
| Full launch simulation (bind→verify→draft→authorize→sign→mine→submit) | 488.9 ms | 554.8 ms |
| Tx status polling | 5.5 ms | 6.7 ms |
| Token discovery | 2.4 ms | — |
| Treasury dashboard | 63.7 ms | — |
| Indexer restart (56 blocks) / 2000-block backlog | 400.4 ms / 116.3 ms | — |

Ledger: materialized folding is 1.7× faster at 10k and 2.2× at 100k events; state remains O(events) (see `W05-DATABASE-LEDGER.md`). Not measured (needs external infra): KMS latency, Postgres under network, real Robinhood RPC, GitHub rate behaviour.

UI evidence: Playwright `test/e2e/w05-ux.spec.ts` (skip link, keyboard focus order, landmarks, mobile no-horizontal-overflow, verification disclosure) against a production build; screenshots are CI artifacts of the e2e job.
