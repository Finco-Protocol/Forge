# W08 — Staging recovery acceptance

Evidence class: SANDBOX / ISOLATED (local Anvil, fake GitHub, disposable compose stack on a GitHub runner; no production infrastructure, keys or assets). This document records what the compose smoke actually executes. Nothing here is production evidence.

## Executed recovery drills (workflow: `.github/workflows/w06-compose-smoke.yml`, manual)

| Drill | Mechanism | Proof required | Status |
|---|---|---|---|
| Worker process crash | host-level `SIGKILL` to the container's host PID (W07 Correction B mechanism — `docker kill` is recorded as a manual stop and never fires the restart policy; verified empirically in run 40246094523) | new StartedAt, increased RestartCount, running state, worker heartbeat healthy via `/api/ops/health`, readiness 200, `chain_events`/`webhook_deliveries`/`jobs` counts unchanged (no duplicate indexing, webhook effects or ledger mutations) | PASS — run 40592825745 @ `f4461cc` (final W08 HEAD; first proven on 40278679711 @ `38aaa5d` in W07) |
| PostgreSQL restart | `docker compose restart postgres` | row counts (`chain_events`, `webhook_deliveries`, `jobs`) identical across the restart; indexer checkpoint monotonic (anvil mines every second; the reconnected worker keeps indexing) | PASS — run 40592825745 @ `f4461cc` (counts 21:0:0 unchanged, checkpoint 51 → 55); first proven 40278679711 @ `38aaa5d` |
| Backup → restore into a second database | worker stopped (quiet state), `pg_dump -Fc` by the postgres container's own binaries, restore into `forge_staging_restore`, digests compared with `staging-ops digest` (`jq`, structured; the staging guard validates the restore target name/host) | reference AND materialized ledger digests identical across the restore AND within each database; `chain_events`/`webhook_deliveries`/`jobs`/`evidence_receipts`/`fin_claim_submissions` counts identical; applied migrations identical; malformed/null payloads fail explicitly | PASS — run 40592825745 @ `f4461cc`: reference = materialized = `ea2eae9a0b28cfec0262b8bc459d3e79e912a8a5bffc24a3bf41b5dc4def9e01` on both databases (first proven 40278679711 @ `38aaa5d`) |
| Chain-write confinement | `docker compose config` parsed BEFORE startup: `FORGE_CHAIN_ID=31337`, `FORGE_RPC_URL=http://anvil:8545`, no external chain endpoint in the resolved config or env | confinement line printed; app containers never start if unsafe | PASS — run 40278679711 @ `38aaa5d` |
| Web process crash (W08 new) | host-level SIGKILL of the web container's host PID | new StartedAt, increased RestartCount, readiness 200 | **EXECUTED** — run 40592825745 @ `f4461cc` (and 40290038031 @ `cce1d4a`) |
| RPC outage (W08 new) | `docker compose pause anvil` (node unreachable) | `/api/health` exposes `failing:["rpc"]` during the outage; readiness recovers after unpause; signing fails closed throughout | **EXECUTED** — run 40592825745 @ `f4461cc`: `failing:["rpc"]` observed; a REAL custody signing attempt through the production guard (scripts/sign-probe.ts, Phase A init on healthy chain → Phase B trigger inside the outage) was refused with the guard's exact `authoritative on-chain read failed (fail closed)` message, audit-verified `denied:allowed:signed = 1:0:0` and zero signatures; recovery after unpause |
| Migration-drift refusal (W08 new) | cloned staging database with EXACTLY ONE tampered checksum (verified written); CONTROL run against the untampered clone first; the real migrate implementation via the committed entrypoint-faithful `ops/staging/migrate-drill.sh` | refusal with the SPECIFIC `MIGRATION_DRIFT` diagnostic; no migration applied during the refusal; the original database proven untouched | **EXECUTED** — run 40592825745 @ `f4461cc`: "migration drift refused with MIGRATION_DRIFT; no migration applied; original database untouched" (control run against the untampered clone passes first) |

## Current-W08 Compose run requirement

The W08 two-phase signing probe was corrected to initialize against **Compose PostgreSQL** and healthy Anvil before publishing a readiness marker. The workflow pauses Anvil **after readiness**, triggers the guard request, checks an explicit authoritative-chain fail-closed denial and the correlated `signer_audit` row, and asserts zero allowed decisions/signatures. Migration drift now has a successful untampered positive control, then requires the specific `MIGRATION_DRIFT` refusal and unchanged original database.

**Evidence status: NOT YET VERIFIED on the final W08 SHA.** No final-head manual run ID exists in this record. Previous historical Compose PASS runs do not transfer to these changes. To close: dispatch `W06 Staging Compose Smoke` on the final W08 branch SHA, inspect every step (including skipped/cancelled), preserve run ID, logs and digest values, and update the PR evidence. Lack of operator dispatch remains `MANUAL_COMPOSE_PENDING_OPERATOR_DISPATCH`, not a PASS.

## Browser E2E repetition (Correction A §2.3)

The J14–J17 flake root cause was the sign-in branch being skipped by a momentary visibility probe racing the streamed dashboard render; the test now waits for the signed-out state deterministically and asserts the session identity before the earnings assertions. On the fixed HEAD `cce1d4a` both the push-triggered and the PR-triggered full browser jobs passed 18/18 (runs 40288260748 / 40288256233 jobs). W07 baseline: 7 consecutive full local runs, 18/18 each.

## Not executed / boundaries

- Production infrastructure, real keys, real assets: never used.
- A failed-migration START attempt (as opposed to drift refusal) on the real stack is covered by the W06 staging suite's migration cases (CI) and the drift refusal here.
- Docker-level backup of volumes (as opposed to `pg_dump` logical backup) is not exercised: the recovery contract is the logical backup.

## History of this workflow (truthful record)

The W06 smoke could not run where it was written (no Docker daemon) and referenced endpoints that did not exist yet. It was first executed in W07 Correction A; runs 40199617462 / 40202457012 / 40204453943 / 40205494954 / 40206342174 / 40207100933 / 40208978491 / 40210337207 / 40213196001 / 40244237507 / 40245257605 / 40246094523 / 40247064339 / 40248117487(canceled) / 40248562796 / 40249512871 / 40250449252 / 40251302375 / 40270510095 / 40271448859 / 40272357986 / 40273310817 / 40274332783 / 40275469787 / 40276554884 / 40277589879 each surfaced one real defect (compose key, container lint, credentials path, writable HOME, package-manager pin, corepack store, crash-drill mechanism, persistence semantics, entrypoint role parsing, missing PG client, digest payload isolation, guard database-name policy) — every one fixed in the same PR before the full-suite pass on run 40278679711. These runs are engineering evidence for the drills themselves; none is a production claim.
