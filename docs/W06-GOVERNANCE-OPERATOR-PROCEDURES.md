# W06 — KMS / Safe / Timelock operator acceptance procedures

Status: **sandbox rehearsal only. Production signing stays refused** (`PRODUCTION_SIGNING_ENABLED=false`, `REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED=false`, `PRODUCTION_BLOCKED=true`). No real KMS, no real Safe, no mainnet. Automation uses **test keys only** (Anvil keys, a fake AWS KMS, a genuine Safe 1.5.0 + OpenZeppelin TimelockController deployed to a local Anvil). Evidence class: `SANDBOX_NOT_EVIDENCE` for B-class custody/governance items — it proves the application and contracts behave as specified when the custody and governance layers behave as specified, not that a real KMS, IAM policy, Safe or signer ceremony does.

Source of truth for design: `docs/W05-SIGNER-CUSTODY.md`, `docs/W05-AUTHORITY-MATRIX.md`, `docs/W05-INCIDENT-RUNBOOK.md`. This document adds the **executable acceptance** layer: step lists with exact commands and the output an operator must see, and the consolidated test that rehearses them.

## 1. Consolidated automated rehearsal

`apps/forge-web/test/integration/w06-governance-acceptance.test.ts` (13 tests, ~35 s, local Anvil + PGlite + fake KMS + Safe + Timelock):

| Claim | Test |
|---|---|
| Authority, evidence, revenue attestor and relayer are four distinct server addresses; treasury and governance owners are external to all of them (real chain reads) | "five custody roles are strictly separated" #1 |
| The relayer is not a custody role; no guard exposes a raw digest signer | #2 |
| An address can be enrolled for exactly one role, durably (`signer_keys.address UNIQUE`) | #3 |
| Cross-role typed data is refused by the allowlist **before** custody is called (0 KMS calls) | #4 |
| A server key equal to the governance owner or the treasury recipient refuses authorization on every role | #5 |
| **RPC outage** (a real TCP outage between app and RPC): authority, revenue and evidence signing all fail closed with **zero KMS calls**, are audited, and resume when the network does; an app that cannot reach the RPC at startup signs nothing | "fails CLOSED when the RPC is unavailable" ×2 |
| Ownership of all 7 Forge contracts moves to Timelock(2 d) ← Safe(2-of-3) | "setup" |
| **Authority rotation** executed by Safe → Timelock on the real registry + authorizer: the old KMS key still signs during the delay window (disclosed), is refused on the very next request after execution with zero custody calls; evidence role unaffected; the documented procedure (`rotateSignerKey` → on-chain change → restart with the new key id) restores service; the old process stays refused; **emergency revocation** of the new key is immediate and chain-independent | "authority rotation via Safe→Timelock" |
| Kill switch: refused with no custody call; released → service resumes | "kill switch" |
| **Revenue attestor**: timelocked `revokeRevenueAttestor()` → old key refused (0 custody calls), pulls paused atomically; NEW `proposeRevenueAttestor` + the splitter's own 3-day timelock (not executable early); a healthy replacement does **not** unpause; replacement KMS key verified after rotate+restart; revoked key never returns; unpause only via a governed `setPullsPaused(false)` | "revenue attestor" |
| Treasury recipient rotated into a **server** key trips the sticky custody violation, and correcting the chain does not silently re-enable | "treasury recipient rotated into a SERVER key" |
| Production signing refused: flags, `KmsDigestSigner` on chains 4663 / 1 / 11155111, `LocalTestDigestSigner`, `buildConfig` for `robinhood`/4663, `createAppContext` on a non-dev chain | "production signing stays refused" |

Existing coverage this builds on (unchanged): `test/integration/w05-signer-freshness.test.ts` (11 tests, stubbed chain), `signer-custody.test.ts` (KMS-signed launches and the attestor incident on Anvil), `unit/signer-guard.test.ts`, `unit/signer-kms.test.ts`, `integration/w05-governance.test.ts`, `test-forge/W05EmergencyRevocation.t.sol`.

Run: `cd apps/forge-web && PATH=/tmp/fdry:$PATH npx vitest run --project integration test/integration/w06-governance-acceptance.test.ts` → expected `Tests 13 passed (13)`.

## 2. Operator procedures

Conventions: `$RPC` = the chain RPC; `$REGISTRY`, `$AUTHORIZER`, `$SPLITTER` = deployed Forge addresses (from the deployment manifest); `$DB` = `psql "$DATABASE_URL"`. There is **no HTTP endpoint and no CLI** for signer controls (by design, W05); the library functions are driven with the one-off `tsx` snippet in §2.0. Signer role status is not exposed by any API in this build — verify with SQL on `signer_keys`, `signer_audit` and `audit_events` (observation, not a defect).

### 2.0 Control snippet (rotate / revoke / kill switch)
From `apps/forge-web`, same environment as the app (`DATABASE_URL`). Verified to run against PGlite in this sandbox:
```
npx tsx -e '
import { openDb } from "./src/server/db";
import { migrate } from "./src/server/db/migrate";
import { engageKillSwitch, releaseKillSwitch, revokeSignerKey, rotateSignerKey } from "./src/server/signer/controls";
(async () => {
  const db = await openDb({ url: process.env.DATABASE_URL, pgliteDir: process.env.FORGE_PGLITE_DIR });
  try {
    await migrate(db);
    // choose ONE:
    await engageKillSwitch(db, "revenue", "<operator-id>", "<INC-id and reason>");
    // await revokeSignerKey(db, "revenue", "<0xKeyAddress>", "<operator-id>", "<reason>");
    // await rotateSignerKey(db, "authority", { address: "<0xNew>", custody: "kms", keyRef: "<key ARN>" }, "<operator-id>", "<reason>");
    // await releaseKillSwitch(db, "revenue", "<operator-id>", "<reason>");
  } finally { await db.close(); }
})();'
```
Expected: exit 0, no output; `SELECT role, engaged FROM signer_kill_switch;` shows the row; `SELECT action, subject FROM audit_events WHERE action LIKE 'ALERT:signer%' ORDER BY id DESC LIMIT 5;` shows `ALERT:signer_kill_switch_engaged` / `ALERT:signer_key_revoked`.

### P1 Role-separation acceptance (read-only)
1. On-chain holders:
   ```
   cast call $REGISTRY   "eligibilityAuthority()(address)" --rpc-url $RPC
   cast call $AUTHORIZER "eligibilityAuthority()(address)" --rpc-url $RPC
   cast call $SPLITTER   "revenueAttestor()(address)"      --rpc-url $RPC
   cast call $SPLITTER   "treasuryRecipient()(address)"    --rpc-url $RPC
   for c in $REGISTRY $AUTHORIZER $SPLITTER; do cast call $c "owner()(address)" --rpc-url $RPC; cast call $c "pendingOwner()(address)" --rpc-url $RPC; done
   ```
   Expected: registry and authorizer name the **same** authority address; the attestor, authority, evidence and relayer addresses are four different values; `owner()` is the Timelock; `treasuryRecipient()` is neither the Timelock's proposer Safe nor any server address.
2. Enrolled keys: `$DB -c "SELECT role, version, address, custody, status FROM signer_keys ORDER BY role, version;"` → exactly one `active` row per configured role, no address under two roles (enforced by `UNIQUE`).
3. Startup log must not contain `signing DISABLED` / `custody violation`; `$DB -c "SELECT subject, detail->>'reason' FROM audit_events WHERE action='ALERT:signer_role_disabled' AND at > now() - interval '1 hour';"` → 0 rows.
4. Automated rehearsal: §1 command. 

### P2 Authority freshness and fail-closed signing (rehearsal)
1. (Staging) Make the RPC unavailable to the app only (firewall rule / stop the RPC proxy).
2. Trigger a launch authorization (or run the §1 test). Expected: HTTP ≥ 400, **no** `Sign` event in the KMS audit trail for that minute, and `$DB -c "SELECT reason FROM signer_audit WHERE decision='denied' ORDER BY id DESC LIMIT 3;"` shows `… fail closed`.
3. Restore the RPC. Expected: the next authorization succeeds with no restart or manual repair.
4. Maximum staleness is **0 blocks**: there is no cache; every request re-reads registry + authorizer authority, splitter attestor, owners, pending owners and treasury recipient.

### P3 Planned authority rotation
1. Create the new KMS key in a recorded ceremony (two people); record its derived address `$NEW`.
2. `cast calldata "setEligibilityAuthority(address)" $NEW` → build one Safe transaction to the Timelock: `scheduleBatch([$REGISTRY,$AUTHORIZER],[0,0],[<calldata>,<calldata>],0x00…00,<unique salt>,172800)`. Collect 2-of-3 signatures; execute. Expected: Timelock event `CallScheduled`; `isOperationReady(id)` = `false`.
3. During the 2-day delay the **old** key keeps signing (disclosed). If it is compromised, do **P4 now**.
4. After the delay: Safe executes `executeBatch(...)`. Expected: both `cast call … eligibilityAuthority()` equal `$NEW`. From this block the old key is refused on the next request (log: `authority signing DISABLED: on-chain eligibilityAuthority … ≠ custody address`).
5. `rotateSignerKey` (§2.0) with `keyRef` = the new ARN. Restart the app with `FORGE_AUTHORITY_KMS_KEY_ID=<new ARN>` and `FORGE_AUTHORITY_EXPECTED_ADDRESS=$NEW`.
6. Expected: `signer_keys` shows version *n* `retired`, version *n+1* `active`; startup log has no `DISABLED`.
7. Authorization check LAST, after any kill-switch release (the signing guard checks the kill switch on every request, so while it is engaged even the correctly rotated new key is refused): if P4 was run first, release the switch explicitly and audibly once steps 4–6 pass — §2.0 `releaseKillSwitch(db,"authority","<operator>","<INC> rotation verified")` — then trigger an authorization. Expected: it succeeds and the `signer_audit` row has `key_version = n+1`. (If P4 never ran, skip the release; the authorization check is the same.)

### P4 Emergency authority-key revocation (suspected compromise)
1. Immediate, off-chain, ≤ 1 min: `pnpm ops:control lockdown on --reason "<INC>" --operator <id>` and §2.0 `engageKillSwitch(db,"authority",…)` then `revokeSignerKey(db,"authority",<addr>,…)`. Expected: next request refused (`kill switch` / `is revoked`) with no custody call; `EMERGENCY_LOCKDOWN_ACTIVE` alert rule fires.
2. Disable the KMS key (break-glass role + MFA); review the cloud `Sign` events for that key against `signer_audit` — any `Sign` without a matching `allowed` row is a custody breach.
3. On-chain kill switch (delayed by the Timelock): Safe schedules `setEligibilityAuthority(address(0))` on the **authorizer** (bricks launches, never opens them), then P3 for the replacement; `invalidatePendingOps(repoId)` for affected repositories (W03 runbook §3).
4. Release the authority kill switch (P3 step 7) and the lockdown (`pnpm ops:control lockdown off …`) only after P3 completes and P1 passes.

### P5 Revenue-attestor revocation and replacement
1. §2.0 `revokeSignerKey(db,"revenue",…)` and/or `engageKillSwitch(db,"revenue",…)` — immediate.
2. Safe → Timelock: `revokeRevenueAttestor()` on `$SPLITTER`. After the delay expect: `revenueAttestor()` = `0x000…0`, `pullsPaused()` = `true`, any pending rotation discarded (`cast call $SPLITTER "pendingRevenueAttestor()(address,uint64,uint64)"` → zero address), `claimTreasury` and creator `claim()` still succeed.
3. Reconcile: compare `EligibleRevenueAuthorized` events with `signer_audit WHERE role='revenue'` and the recomputed eligible revenue; quantify headroom above it (third-party credit, bounded by the escrow balance).
4. Replacement: create key; `rotateSignerKey`; Safe → Timelock `proposeRevenueAttestor($NEW)`; wait `RECIPIENT_TIMELOCK()` (3 days). Executing early must revert `TimelockNotElapsed`. Anyone may then call `executeRevenueAttestorChange()`. Expected: `revenueAttestor()` = `$NEW`, **`pullsPaused()` still `true`**.
5. Restart with the new revenue key id/address; expected `verified` (no `DISABLED`).
6. Only after review: Safe → Timelock `setPullsPaused(false)`. Note: any over-authorized headroom becomes pullable again at this moment (the ceiling cannot be lowered on chain).

### P6 Relayer key loss
Relayer holds no authority. Stop the worker, drain the old gas key, set a new `FORGE_RELAYER_PRIVATE_KEY` + `FORGE_RELAYER_EXPECTED_ADDRESS`, restart. Expected: startup succeeds (the relayer must differ from every owner and from the treasury recipient, else `custody violation … relayer`).

### P7 Treasury recipient rotation and custody-violation recovery
1. Safe → Timelock `proposeTreasuryRecipient($NEWT)`; after `RECIPIENT_TIMELOCK()` anyone calls `executeTreasuryRecipientChange()`. Allocated liabilities stay claimable by the new recipient.
2. If `$NEWT` equals any server key, every signing role is refused with `custody violation … treasury recipient` **and stays refused after the chain is corrected** — restart the app after P1 passes.

### P8 Production signing is refused (negative acceptance)
Run `cd apps/forge-web && npx vitest run --project integration test/integration/w06-governance-acceptance.test.ts -t "production signing"` → 1 passed. Manual check: starting the app with `FORGE_SIGNER_PROVIDER=kms FORGE_CHAIN_ID=4663` must refuse to start with `PRODUCTION_BLOCKED` (asserted through `buildConfig` / `createAppContext` in the test). Enabling production signing is a separate reviewed change (W05-SIGNER-CUSTODY §9) and is **not** part of W06.

## 3. Not proven here (explicit)
Real AWS/GCP KMS endpoint calls, IAM/key policies and CloudTrail↔`signer_audit` reconciliation (B-class); a real Safe ceremony and signer hardware; that a timelocked emergency response is fast enough (the delay window in P3/P4/P5 is a **disclosed** governance trade-off; the off-chain kill switch is the bridge); production alert routing. Observation: the `ALERT:signer_*` audit events have no `ALERT_RULES` entry in `monitor.ts`, so they are only visible by SQL until the operator wires them (B06).
