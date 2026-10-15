# W06 — Controlled-beta STAGING package

Status: **non-production**. No cloud resource was created and nothing was deployed. `PRODUCTION_BLOCKED=true`, `FINCO_BURN_ENABLED=false`, `FORGE_FEE_POLICY_AUTHORITY_UNPROVEN=true`, `PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `DEPLOY_WRITE_ENABLED=false`.

## What is in the package
| Piece | Path | Notes |
|---|---|---|
| Orchestration | `ops/staging/docker-compose.staging.yml`, `Dockerfile`, `entrypoint.sh`, `.env.staging.example` | postgres, anvil, simulated GitHub, one-shot `deploy` + `migrate`, `web`, `worker`. The `backend` network is `internal: true`; only `web` (3000) and the simulated GitHub (8787, for the browser OAuth hop) publish a port, both on 127.0.0.1. |
| Staging guard | `apps/forge-web/src/server/staging/guard.ts` | `FORGE_STAGING=true` makes every process refuse an unsafe environment **before the database is opened** (`context.ts`). |
| Health | `GET /api/live` (process only), `GET /api/ready` (200 only when schema migrated, indexer caught up, ledger not halted, a live worker heartbeat; else 503), `GET /api/health` (public booleans), `GET /api/ops/health` + `/api/ops/metrics` (bearer `FORGE_OPS_TOKEN`) | structured JSON logs with correlation ids already existed (W05). |
| Build / deployment manifest | `pnpm staging:manifest` → `scripts/w06/staging-lib.ts` | git SHA, package version, Node, migration names + checksums, lockfile / authority-matrix / readiness-manifest / security-baseline / compose digests, frozen flags, self-digest. `pnpm staging:verify <file>` detects tampering, flag drift and migration drift. |
| Backup / restore / rollback | `pnpm staging:snapshot`, `pnpm staging:rollback-plan` | `pg_dump -Fc` + a sidecar with the ledger digests; restore only into a NEW database. There are **no down migrations**: rolling back to an older build is `code-only` only if the database holds no migration the older build does not know; otherwise the plan is `restore-snapshot-required`. |
| Process-based acceptance | `scripts/w06/staging-stack.ts`, `test/staging/staging-accept.test.ts` (`pnpm test:staging`) | the same topology as the compose file, as separate OS processes. |

## Bring-up (operator, needs Docker)
```
cp ops/staging/.env.staging.example ops/staging/.env.staging      # replace the four secrets with fresh random values
docker compose -f ops/staging/docker-compose.staging.yml --env-file ops/staging/.env.staging up --build
curl -fsS http://127.0.0.1:3000/api/ready
```
`.github/workflows/w06-compose-smoke.yml` (manual `workflow_dispatch`) does exactly this on a runner. **It has not been run**: the compose file was written where no Docker daemon exists and was only linted and statically checked (`test/unit/w06-staging-package.test.ts`). Treat compose as `NOT_EXECUTED` until that workflow has been run once. Image tags: Postgres is digest-pinned; the Foundry image is tag-pinned (`v1.8.5`) — resolve and pin its digest before relying on it.

## What the guard refuses (negative tests: `w06-staging-guard.test.ts`, 31 cases; live in `staging-accept`)
Chain 4663 / any chain other than 31337/1337; `FORGE_NETWORK=robinhood`; an RPC whose host is not loopback or explicitly allow-listed, or is a known public provider (even if allow-listed by mistake); an RPC whose `eth_chainId` is not a local dev chain (probed at start); real GitHub hosts; `FORGE_SIGNER_PROVIDER=kms`; any private key that is not one of the ten public Anvil dev keys; `FINCO_BURN_ENABLED`, `PRODUCTION_SIGNING_ENABLED`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED`, `DEPLOY_WRITE_ENABLED` enabled or `PRODUCTION_BLOCKED` cleared; PGlite instead of PostgreSQL; a database not named `forge_staging*` or on a managed-cloud host; sample/short `SESSION_SECRET` or `FORGE_OPS_TOKEN`; a public origin that is not loopback/allow-listed. All violations are reported at once. The shipped example secrets are placeholders the guard rejects until replaced.

## Acceptance evidence (`docs/evidence/w06/staging-acceptance.json`, local run)
Real: PostgreSQL 16, separate `next start` web and `tsx scripts/worker.ts` processes, migrations, `pg_dump`/`pg_restore`, SIGTERM/SIGKILL. Simulated: Anvil chain, in-process GitHub.

| Step | Observed |
|---|---|
| config refusal | 7 unsafe configurations refused in-process; a worker process with chain 4663 exited non-zero with `STAGING_CONFIG_REFUSED`; the database had **no schema** afterwards |
| production-chain probe | an RPC answering `0x1237` (4663) refused; Anvil (31337) accepted |
| migrate from empty | all migrations applied; a second run applied none |
| cold start | web + worker become `/api/ready`; `/api/ops/health` requires the bearer token (401 without) |
| restart with state | SIGTERM → worker exit 0; after restart the same tokens and an **identical ledger digest** |
| indexer recovery | with the worker stopped and 3 buys mined: lag > 0, `/api/ready` = 503; after restart lag 0 and reference digest == materialized digest |
| worker crash | SIGKILL while a job lease was held; the job completed after the lease expired |
| failed migration | a migration with a failing second statement left no table and no `schema_migrations` row; a build in `verify` mode against an un-migrated database refused to start (`DB_STARTUP_CHECK_FAILED`) |
| backup / restore | `pg_dump` of the live DB restored into a new DB: equal ledger digest, materialized digest, migration checksums and row counts of the financial tables |
| rollback plan | current manifest → `code-only`; a manifest without the last migration → `restore-snapshot-required` |
| manifest | verifies; a tampered copy is detected |

Not covered here (stated, not hidden): compose execution; clean-install from an empty checkout is exercised by CI (`pnpm install --frozen-lockfile` in every job) and by `scripts/w06/clean-install.sh` locally; no real KMS, RPC latency or GitHub.
