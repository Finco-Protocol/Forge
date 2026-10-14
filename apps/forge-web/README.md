# FINCO Forge — W03 Verified Builder Platform (`apps/forge-web`)

The user-facing launchpad around the W02 protocol core:

**GitHub App → verified repository admin → SIWE wallet binding → registry binding (on chain) → eligibility attestation → creator EIP-712 consent → launch through the W02 Forge factory → indexed lifecycle → Proof of Build.**

> **Status: sandbox only. `PRODUCTION_BLOCKED`.** The app refuses chain 4663, refuses a local signing key anywhere but a local dev chain, and keeps `FINCO_BURN_ENABLED=false`. See `docs/W03-SECURITY-RUNBOOK.md` and `docs/W03-W04-HANDOVER.md`.

## Architecture (one deployable + one worker)

| Layer | Where | Notes |
| --- | --- | --- |
| UI | `src/app/*` (Next.js 15 App Router, React 19) | Explore, Project detail, 5-step Launch wizard, Creator dashboard |
| Wallet | wagmi 2 `injected()` (any EIP-1193 wallet) + viem | EOA required: the W02 authorizer verifies ECDSA consent only |
| HTTP API | `src/server/api/handlers.ts` behind one catch-all route | same dispatcher is exercised by the integration tests |
| Sessions / CSRF | `src/server/session.ts` | opaque HttpOnly cookie (sha256 stored), rotated on sign-in; HMAC double-submit CSRF + strict Origin check |
| GitHub App | `src/server/github/*` | App JWT (RS256), installation tokens, user-to-server OAuth; webhooks; reconciliation |
| Eligibility authority | `src/server/eligibility/*`, `src/server/signer/*` | policy-gated signer; digest-only custody port (KMS/HSM-shaped) |
| Launch service | `src/server/launch/service.ts` | drafts, economics preview, intents, simulation, submission tracking, recovery |
| Indexer | `src/server/indexer/*` | allowlisted addresses, confirmations, reorg rollback, idempotent replay, reconciliation |
| Proof of Build | `src/server/proof/ledger.ts` | append-only, hash-chained, signed receipts |
| Persistence | PostgreSQL (`DATABASE_URL`) — or PGlite (same SQL, embedded) for sandbox/tests | `src/server/db/migrations/*.sql`; immutability via triggers |
| Worker | `pnpm worker` (or embedded in sandbox) | indexer, receipts, on-chain revocation jobs, reconciliation |
| Contract ABIs | `src/shared/abis.generated.ts` | generated from `forge build --profile forge`; CI fails on drift |

The W03 app drives the W02 Forge-owned stack (`contractsV2-forge`). W03 Correction A changed only the factory→authorizer hand-off to fit EIP-170 (`docs/MODIFICATION-REGISTER.md` §7); financial contracts are unchanged.

## Proof model — what proves what

| Claim | Proven by | Class |
| --- | --- | --- |
| User X administers repo id R | user's own token (`GET /repositories/:id` → `permissions.admin`) **and** installation's collaborator-permission view of user id X | service-attested (GitHub) |
| The App installation covers R | installation token lists R; installation account == repo owner | service-attested (GitHub) |
| Wallet W consents to bind to X | one-time SIWE challenge (session-, domain-, chain-bound, 5 min) | cryptographic (EIP-191) |
| R is bound to W | `ForgeBindingRegistry.Bound/OperationApplied` (authority-signed op, Correction-B op-chain) | on-chain |
| W may launch for R now | authority `EligibilityAttestation` under the **current** binding epoch | on-chain (verified by authorizer) |
| W consents to these exact launch terms | creator `LaunchAuthorization` (metadata, tax, fee recipient, buyback, exemption set, economics digest, salt, nonce, expiry) | on-chain (verified by authorizer) |
| Token T was launched for R by W | `LaunchAuthorized(W, R)` + `TokenLaunched(T, curve, W)` in the same tx from the allowlisted contracts | on-chain |
| Commit SHA, repo name at that time | verification evidence (hash in the Proof of Build receipt) | service-attested |

An installation token alone is **never** treated as proof of administration, and wallet ownership is **never** treated as repository administration. GitHub verification is not a code audit, KYC, or proof of financial legitimacy.

## Local development (sandbox)

Prerequisites: Node 22, pnpm 10, Foundry 1.8.5 (`forge`, `anvil`).

```bash
# 1. Build the W02 contracts (repository root)
forge build --profile forge

# 2. App deps
cd apps/forge-web && pnpm install

# 3. Local chain — a standard Anvil (EIP-170 enforced; never disable the size limit)
anvil &

# 4. Deploy the real W02 stack (V4 legs are the W02 mini mocks) → .sandbox/deployment.json
pnpm sandbox:deploy

# 5. Sandbox GitHub (mocked boundary) → .sandbox/github.env; seeds finco-labs/forge-demo with admin @alice-admin
pnpm sandbox:fake-github &

# 6. Run the app with the embedded worker
cp .env.example .env.local && cat .sandbox/github.env >> .env.local
pnpm dev     # http://localhost:3000
```

Use a browser wallet pointed at `http://127.0.0.1:8545` (chain 31337) with an Anvil dev account (e.g. #5).

With a real GitHub App instead of the sandbox GitHub: create a GitHub App with **Repository permissions: Metadata (read), Contents (read)**, **"Request user authorization (OAuth) during installation"**, callback `…/api/auth/github/callback`, setup URL `…/api/github/setup`, webhook `…/api/github/webhook` subscribed to `installation`, `installation_repositories`, `repository`, `member`, `organization`, `team`, `membership`. Put its id, slug, client id/secret, private key and webhook secret in `.env.local`.

## Tests

| Command | What | Boundary |
| --- | --- | --- |
| `pnpm typecheck` / `pnpm lint` | TS strict + ESLint (client code may not import server modules) | — |
| `pnpm test` | unit (typed-data helpers, crypto, migrations on real Postgres/PGlite) | — |
| `pnpm test:integration` | acceptance path 1–15, all mandatory negative cases, EIP-712 parity | real W02 contracts on Anvil; real API/session/CSRF/DB; **only GitHub is mocked** (local HTTP server enforcing JWT/permission semantics) |
| `pnpm test:e2e` | Playwright over `next build && next start` | browser wallet = EIP-1193 provider forwarding to Anvil dev account |
| `pnpm test:fork` | read-only Robinhood 4663 V4 wiring | needs `FORGE_FORK_RPC_URL` |
| `pnpm abi:check` | committed ABIs == W02 build output | — |
| `pnpm size:check` | EIP-170 gate: every Forge runtime ≤ 24,576 B, factory margin ≥ 64 B | — |

## Operations

- Production uses PostgreSQL + `pnpm worker` (separate process), never PGlite.
- Revocation monitoring: `GET /api/health` → `revocations` (pending, oldest age, retrying, last latency, SLO `FORGE_REVOCATION_SLO_SECONDS`, `breached`). Page on `breached` and on `ALERT:*` audit events.
- Behind a reverse proxy set `FORGE_TRUSTED_PROXY_HOPS` to the exact number of proxies that append `X-Forwarded-For`; the default `0` never trusts the header.
- Indexer finality: set `FORGE_CONFIRMATIONS` (sandbox 0). Reorgs deeper than `FORGE_INDEXER_REORG_WINDOW` stop the indexer for manual intervention.
- Runbook: `docs/W03-SECURITY-RUNBOOK.md`. Handover/blockers: `docs/W03-W04-HANDOVER.md`.
