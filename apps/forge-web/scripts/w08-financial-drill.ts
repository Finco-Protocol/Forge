/**
 * W08 financial recovery drill — Compose-only, execution-backed.
 *
 * Drives the REAL application flow against the running compose stack
 * (real HTTP API, real PostgreSQL, real Anvil chain, real worker, the
 * simulated-GitHub boundary) through:
 *
 *   setup → GitHub OAuth + wallet bind + repository admin proof → launch
 *   (real EIP-712 + real launch transaction) → trades crossing the graduation
 *   threshold → graduation sweep (protocol leg credited to the splitter key,
 *   creator leg to the creator key) → worker attestation (verified headroom)
 *   → REORG just past the attestation (snapshot/revert) → rollback + recovery
 *   assertions → INTERRUPTED claim (canonical escrow.claim payout, worker
 *   stopped before indexing, restart, exactly-once ingestion, duplicate claim
 *   refusal, no double allocation).
 *
 * No mocks: every amount is read from the chain, the PostgreSQL ledger or the
 * API. Test-only values (simulated GitHub, Anvil dev keys); never production.
 * Output: one JSON evidence payload on stdout; nonzero exit on any violation.
 */
import { createPublicClient, createWalletClient, defineChain, http, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
const pkToAccount = privateKeyToAccount;
import { PgDb } from "../src/server/db";
import { ponsV2LaunchFactoryAbi, ponsV2BondingCurveAbi, ponsV2FeeEscrowAbi, forgeProtocolRevenueSplitterAbi } from "../src/shared/abis.generated";
import { reviveLaunchArgs, reviveTypedData } from "../src/shared/launch-tx";
import { ANVIL_KEYS } from "./sandbox-lib";
import { decodeErrorResult } from "viem";
import type { Abi } from "viem";

// viem contract errors dump the entire ABI when uncaught — print compactly instead.
process.on("uncaughtException", (e) => {
  const c = e as { message?: string; shortMessage?: string; name?: string; cause?: { message?: string; errorName?: string } };
  console.error(`W08_FINANCIAL_DRILL_CRASH ${c.name}: ${c.shortMessage ?? c.message} | cause: ${c.cause?.errorName ?? c.cause?.message ?? "none"}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  const c = e as { message?: string; shortMessage?: string; name?: string; cause?: { message?: string; errorName?: string } };
  console.error(`W08_FINANCIAL_DRILL_CRASH ${c.name}: ${c.shortMessage ?? c.message} | cause: ${c.cause?.errorName ?? c.cause?.message ?? "none"}`);
  process.exit(1);
});

const WEB = process.env.DRILL_WEB_ORIGIN ?? "http://web:3000";
// The app's same-origin guard compares the Origin header against its configured
// FORGE_PUBLIC_ORIGIN (http://localhost:3000 in compose) — NOT the container-to-
// container address the drill fetches.
const APP_ORIGIN = process.env.DRILL_APP_ORIGIN ?? "http://localhost:3000";
const GH = process.env.DRILL_FAKE_GITHUB ?? "http://fake-github:8787";
const ANVIL = process.env.DRILL_ANVIL ?? "http://anvil:8545";
const CHAIN = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } } });
const CREATOR_KEY = ANVIL_KEYS[4];
const creator = privateKeyToAccount(CREATOR_KEY as `0x${string}`);
const BUYER_KEY = ANVIL_KEYS[8];
const buyer = pkToAccount(BUYER_KEY as `0x${string}`);
const pub = createPublicClient({ chain: CHAIN, transport: http(ANVIL) });
const creatorWallet = createWalletClient({ chain: CHAIN, transport: http(ANVIL), account: creator });
const buyerWallet = createWalletClient({ chain: CHAIN, transport: http(ANVIL), account: buyer });

const cookies = new Map<string, string>();
async function api(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {};
  headers.origin = APP_ORIGIN; // the app's same-origin guard compares against FORGE_PUBLIC_ORIGIN
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (opts.csrf !== false && cookies.get("forge_csrf")) headers["x-forge-csrf"] = decodeURIComponent(cookies.get("forge_csrf")!);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${WEB}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv!.indexOf("=");
    const name = kv!.slice(0, i), value = kv!.slice(i + 1);
    if (/Max-Age=0/i.test(c)) cookies.delete(name); else cookies.set(name, decodeURIComponent(value));
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { if (text) json = JSON.parse(text) as Record<string, unknown>; } catch { /* redirect/empty */ }
  return { status: res.status, json, headers: res.headers };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll<T>(label: string, timeoutMs: number, f: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < end; i++) {
    const v = await f().catch(() => null);
    if (v !== null) return v;
    await sleep(2_000);
    if (i % 10 === 9) console.error(`[drill] still waiting: ${label}`);
  }
  throw new Error(`drill timeout: ${label}`);
}
async function anvil(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`anvil ${method}: ${j.error.message}`);
  return j.result;
}

// ── evidence accumulators ────────────────────────────────────────────────
const evidence: Record<string, unknown> = {};
let fail = "";

// ── Phase S: seed the simulated-GitHub scenario state ────────────────────
const USER = { id: 3001, login: "w08-fin-drill" };
const ORG = { id: 4001, login: "w08-org", type: "Organization" };
const REPO_ID = 7001;
const INST_ID = 8001;
const ctrl = async (action: string, body: unknown) => {
  const r = await fetch(`${GH}/__control/${action}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (r.status !== 200) throw new Error(`fake-github control ${action} -> ${r.status}`);
};
await ctrl("add-user", { id: USER.id, login: USER.login });
await ctrl("add-repo", { id: REPO_ID, name: "w08-fin", owner: ORG });
await ctrl("set-permission", { repoId: REPO_ID, userId: USER.id, perm: "admin" });
await ctrl("install", { id: INST_ID, account: ORG, repoIds: [REPO_ID] });
await ctrl("login-as", { userId: USER.id });
evidence.setup = "github state seeded (user/repo/installation/admin)";

// ── Phase A: real GitHub OAuth + wallet bind + repository admin proof ────
const start = await api("GET", "/api/auth/github/start");
if (start.status !== 302 && start.status !== 200) throw new Error(`oauth start -> ${start.status}`);
const authorizeUrl = start.headers.get("location") ?? "";
if (!authorizeUrl) throw new Error("oauth start returned no redirect");
  // The app's redirect points at the fake-github address as seen from the HOST
  // (127.0.0.1:8787, the published port). Inside the compose network the fake
  // github is reachable at DRILL_FAKE_GITHUB — rewrite the origin.
  const authorizeUrlInternal = new URL(authorizeUrl, WEB);
  authorizeUrlInternal.protocol = new URL(GH).protocol;
  authorizeUrlInternal.host = new URL(GH).host;
  const authorize = await fetch(authorizeUrlInternal, { redirect: "manual" });
const callback = authorize.headers.get("location");
if (!callback) throw new Error("fake-github authorize returned no redirect");
const cb = await api("GET", callback.replace(/^https?:\/\/[^/]+/, ""));
if (cb.status !== 302) throw new Error(`oauth callback -> ${cb.status}: ${JSON.stringify(cb.json).slice(0, 300)}`);
const jarKeys = [...cookies.keys()].join(",");
const me = await api("GET", "/api/me");
// /api/me returns { github: { id, login }, wallet, chainId } — the GitHub binding is
// what the drill must confirm (the diagnostics run proved the session was fine).
const myGithub = me.json.github as { login?: string } | undefined;
if (myGithub?.login !== USER.login)
  throw new Error(
    `session is ${myGithub?.login ?? "none"}, expected ${USER.login} (jar: ${jarKeys}; me.status ${me.status}; me.body ${JSON.stringify(me.json).slice(0, 200)})`,
  );
const ch = await api("POST", "/api/wallet/challenge", { address: creator.address, chainId: 31337 });
if (ch.status !== 200) throw new Error(`wallet challenge -> ${ch.status}`);
const signature = await creatorWallet.signMessage({ message: ch.json.message as string });
const wv = await api("POST", "/api/wallet/verify", { message: ch.json.message, signature });
if (wv.status !== 200) throw new Error(`wallet verify -> ${wv.status}: ${JSON.stringify(wv.json)}`);
const vf = await api("POST", "/api/github/verify", { repoId: REPO_ID, installationId: INST_ID });
if (vf.status !== 200) throw new Error(`repository verify -> ${vf.status}: ${JSON.stringify(vf.json)}`);
evidence.auth = `signed in as ${USER.login}; wallet ${creator.address} bound; repository admin proven`;

// ── Phase B: real launch (EIP-712 consent + real launch transaction) ─────
const draft = await api("POST", "/api/launch/drafts", { repoId: REPO_ID, installationId: INST_ID, name: "W08 Fin", symbol: "W08F", description: "W08 financial recovery drill (sandbox)", logo: "https://example.org/w08.png", socials: {}, launchConfigId: 0, creatorTaxBps: 100, buybackEnabled: false, snipeTaxExemptions: [] });
if (draft.status !== 201) throw new Error(`draft -> ${draft.status}: ${JSON.stringify(draft.json)}`);
const auth = await api("POST", `/api/launch/drafts/${draft.json.id}/authorize`);
if (auth.status !== 200) throw new Error(`authorize -> ${auth.status}: ${JSON.stringify(auth.json)}`);
const typedData = reviveTypedData(auth.json.typedData as { domain: Record<string, unknown>; message: Record<string, unknown> });
const consent = await creatorWallet.signTypedData(typedData as never);
const signed = await api("POST", `/api/launch/intents/${auth.json.intentId}/signature`, { signature: consent });
if (signed.status !== 200) throw new Error(`signature submit -> ${signed.status}: ${JSON.stringify(signed.json)}`);
const args = reviveLaunchArgs(signed.json.tx as never);
const launchHash = await creatorWallet.writeContract({ address: (signed.json.tx as { address: Address }).address, abi: ponsV2LaunchFactoryAbi as unknown as Abi, functionName: "launchToken", args: [args.params, args.launchConfigId, args.pairToken, args.exemptions], value: args.value } as never);
await pub.waitForTransactionReceipt({ hash: launchHash });
const submitted = await api("POST", `/api/launch/intents/${auth.json.intentId}/submitted`, { txHash: launchHash });
if (submitted.status !== 200) throw new Error(`submitted -> ${submitted.status}: ${JSON.stringify(submitted.json)}`);
const token = await poll("token indexed", 120_000, async () => {
  const tokens = (await (await fetch(`${WEB}/api/tokens`)).json()) as { tokens: Array<{ token: string; curve: string; creator: string }> };
  const mine = tokens.tokens.find((t) => t.creator.toLowerCase() === creator.address.toLowerCase());
  return mine ?? null;
});
evidence.launch = `token ${token!.token} launched (curve ${token!.curve})`;

// ── Phase C: trades crossing the graduation threshold (30 ETH) ───────────
const curve = token!.curve as Address;
const buy = async (eth: string) => {
  const v = BigInt(eth);
  try {
    const h = await buyerWallet.writeContract({ address: curve, abi: ponsV2BondingCurveAbi as unknown as Abi, functionName: "buy", args: [v, 0n, buyer.address], value: v } as never);
    await pub.waitForTransactionReceipt({ hash: h });
    return h;
  } catch (e) {
    const c = e as { cause?: { data?: string; message?: string }; shortMessage?: string; message?: string };
    const decoded = c.cause?.data ? (() => { try { return decodeErrorResult({ abi: ponsV2BondingCurveAbi as unknown as Abi, data: c.cause!.data! }).errorName; } catch { return "undecoded"; } })() : "no-data";
    throw new Error(`buy(${eth}) reverted: ${c.shortMessage ?? c.message} | raw: ${c.cause?.data ?? "none"} | decoded: ${decoded}`);
  }
};
// clear the anti-snipe window exactly like the e2e (J10): the launch-second
// snipe tax would otherwise take the buyer's tokens down to the 1% floor.
await anvil("evm_increaseTime", [30]);
await anvil("evm_mine");
await buy("10000000000000000000"); // 10 ETH
const db = new PgDb(process.env.DATABASE_URL!, { max: 2, applicationName: "w08-drill" });
const chainEvents = async () => Number((await db.query<{ n: string }>("SELECT count(*)::text n FROM chain_events")).rows[0]!.n);
const gradHash = await buy("25000000000000000000"); // 22 ETH crosses the 30 ETH threshold
await pub.waitForTransactionReceipt({ hash: gradHash });
const gradPhase = await poll("graduation phase", 120_000, async () => {
  const t = (await (await fetch(`${WEB}/api/tokens/${token!.token}`)).json()) as { token: { phase: string } };
  return /graduation_initiated|graduated/.test(t.token.phase) ? t.token.phase : null;
});
void gradPhase;
const factoryAddr = ((await (await fetch(`${WEB}/api/config`)).json()) as { addresses: { factory: Address } }).addresses.factory;
await creatorWallet.writeContract({ address: factoryAddr, abi: ponsV2LaunchFactoryAbi as unknown as Abi, functionName: "createGraduatedPool", args: [token!.token] } as never);
await poll("graduated pool", 120_000, async () => {
  const t = (await (await fetch(`${WEB}/api/tokens/${token!.token}`)).json()) as { token: { phase: string } };
  return t.token.phase === "graduated" ? true : null;
});

// ── Phase D: worker attestation of the swept protocol leg ────────────────
const cfgAddresses = ((await (await fetch(`${WEB}/api/config`)).json()) as { addresses: Record<string, string> }).addresses;
const splitter = cfgAddresses.revenueSplitter as Address;
const escrow = cfgAddresses.feeEscrow as Address;
const NATIVE = zeroAddress as Address;
const headroom = async () => pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi as unknown as Abi, functionName: "verifiedHeadroom", args: [NATIVE] } as never) as Promise<bigint>;
const ceiling = async () => (await pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi as unknown as Abi, functionName: "ledger", args: [NATIVE] } as never) as never as { eligibleCeiling: bigint }).eligibleCeiling;
const escrowCredit = async (who: Address) => pub.readContract({ address: escrow, abi: ponsV2FeeEscrowAbi as unknown as Abi, functionName: "balanceOf", args: [who] } as never) as Promise<bigint>;
await poll("attestation (verified headroom > 0)", 180_000, async () => ((await headroom()) > 0n ? true : null));
const ceilingBeforeReorg = await ceiling();
const escrowBeforeReorg = await escrowCredit(creator.address);
const eventsBeforeReorg = await chainEvents();
evidence.attestation = `ceiling ${ceilingBeforeReorg.toString()} wei attested; splitter headroom > 0; creator escrow credit ${escrowBeforeReorg.toString()} wei`;

// ── Phase E: REORG just past the attestation ─────────────────────────────
const snapshot = (await anvil("evm_snapshot")) as string;
await buy("5000000000000000000"); // 5 ETH of new fees after the snapshot
await creatorWallet.writeContract({ address: curve, abi: ponsV2BondingCurveAbi as unknown as Abi, functionName: "sweepFees", args: [0n, false] } as never);
await poll("post-reorg-sweep indexed (events grow)", 120_000, async () => ((await chainEvents()) > eventsBeforeReorg ? true : null));
const ceilingAtPeak = await ceiling();
await anvil("evm_revert", [snapshot]);
await poll("reorg rollback (events back to pre-reorg)", 180_000, async () => ((await chainEvents()) === eventsBeforeReorg ? true : null));
const ceilingAfterReorg = await ceiling();
const escrowAfterReorg = await escrowCredit(creator.address);
const eventsAfterReorg = await chainEvents();
const rec = (await pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi as unknown as Abi, functionName: "reconcile", args: [NATIVE] } as never)) as never as { deficit: bigint; surplus: bigint };
const reorgOk =
  ceilingAfterReorg === ceilingBeforeReorg && // the orphaned attestation authorization was reverted on chain
  escrowAfterReorg === escrowBeforeReorg &&   // the reorged sweep credit is gone from the escrow
  eventsAfterReorg === eventsBeforeReorg &&   // indexed events rolled back (no duplicate/orphan retention)
  rec.deficit === 0n && rec.surplus === 0n;   // the ledger reconciles with the chain exactly
evidence.reorg = {
  rollbackOk: eventsAfterReorg === eventsBeforeReorg,
  ceilingRolledBack: ceilingAfterReorg === ceilingBeforeReorg,
  noDoubleCount: reorgOk,
  ceilingAtPeak: ceilingAtPeak.toString(),
  ceilingAfterReorg: ceilingAfterReorg.toString(),
  eventsBeforeReorg, eventsAfterReorg,
  reconcile: { deficit: rec.deficit.toString(), surplus: rec.surplus.toString() },
};
if (!reorgOk) fail = "reorg recovery violated a financial assertion";

// ── Phase F: recovery — fresh attestation after the reorg ────────────────
const c2 = (await poll("post-reorg ceiling re-attestable", 240_000, async () => {
  const h = await headroom().catch(() => 0n);
  return h > 0n && (await ceiling()) >= ceilingBeforeReorg ? true : null;
})) === true;
evidence.attestationRecovery = c2
  ? "fresh canonical evidence re-attested after the reorg (ceiling recovered with in-window block hashes)"
  : "RE-ATTESTATION PENDING (worker will retry with fresh canonical evidence)";
if (!c2) fail = fail || "post-reorg re-attestation did not recover";

// ── Phase G: creator claim (canonical payout) — interrupted + recovered ──
// Two-phase protocol with the workflow: the drill waits for the `claim_go`
// marker (the workflow has STOPPED the worker, so indexing is guaranteed
// interrupted), sends the canonical escrow.claim payout while the worker is
// down, prints W08_CLAIM_TX, then waits for `claim_go2` (worker restarted)
// and verifies exactly-once ingestion, duplicate refusal and conservation.
await db.query("CREATE TABLE IF NOT EXISTS w08_drill_control (id text primary key, at timestamptz default now())");
const marker = async (id: string) => {
  const t = await db.query<{ n: string }>("SELECT count(*)::text n FROM w08_drill_control WHERE id = $1", [id]).catch(() => ({ rows: [] as { n: string }[] }));
  return Number((t as { rows: Array<{ n: string }> }).rows[0]?.n ?? 0) > 0;
};
const creatorCredit = await escrowCredit(creator.address);
console.log("W08_CLAIM_WAITING (worker must be stopped now)");
await poll("claim_go marker (worker stopped)", 300_000, async () => (await marker("claim_go")) ? true : null);
const claimHash = await creatorWallet.writeContract({ address: escrow, abi: ponsV2FeeEscrowAbi as unknown as Abi, functionName: "claim" } as never);
await pub.waitForTransactionReceipt({ hash: claimHash });
const creatorBalanceAfterPayout = await escrowCredit(creator.address);
if (creatorBalanceAfterPayout !== 0n) { fail = "escrow did not drain the creator credit exactly"; }
const unindexed = (await db.query<{ n: string }>("SELECT count(*)::text n FROM chain_events WHERE tx_hash = $1", [claimHash])).rows[0]!.n;
if (unindexed !== "0") throw new Error("the claim event was indexed while the worker was stopped (interrupted window violated)");
evidence.claimInterrupted = { claimTx: claimHash, payout: creatorCredit.toString(), escrowDrained: creatorBalanceAfterPayout === 0n, indexedWhileDown: 0 };
console.log("W08_CLAIM_TX " + claimHash);
await poll("claim_go2 marker (worker restarted)", 300_000, async () => (await marker("claim_go2")) ? true : null);
const claimEventsForTx = async () => Number((await db.query<{ n: string }>("SELECT count(*)::text n FROM chain_events WHERE tx_hash = $1", [claimHash])).rows[0]!.n);
await poll("claim event indexed exactly once", 240_000, async () => {
  const n = await claimEventsForTx();
  return n >= 1 ? n : null;
});
const indexedOnce = await claimEventsForTx();
await sleep(10_000); // extra worker passes: must NOT add a second copy
const indexedStill = await claimEventsForTx();
const _dup = await creatorWallet.writeContract({ address: escrow, abi: ponsV2FeeEscrowAbi as unknown as Abi, functionName: "claim" } as never).then((h) => h).catch((e: Error) => { void e; return "reverted" as const; });
const creatorBalanceAfterDuplicate = await escrowCredit(creator.address);
const rec2 = (await pub.readContract({ address: splitter, abi: forgeProtocolRevenueSplitterAbi as unknown as Abi, functionName: "reconcile", args: [NATIVE] } as never)) as never as { deficit: bigint; surplus: bigint };
const claimOk =
  indexedOnce === 1 && indexedStill === 1 && // exactly-once ingestion across worker restart + extra passes
  creatorBalanceAfterPayout === 0n && creatorBalanceAfterDuplicate === 0n && // no double allocation
  rec2.deficit === 0n && rec2.surplus === 0n; // ledger reconciles
evidence.claimRecovery = {
  exactlyOnce: indexedOnce === 1 && indexedStill === 1,
  duplicateReverted: creatorBalanceAfterDuplicate === 0n,
  noDoubleAllocation: claimOk,
  indexedOnce, indexedStill,
  reconcile: { deficit: rec2.deficit.toString(), surplus: rec2.surplus.toString() },
};
if (!claimOk) fail = fail || "claim recovery violated an idempotency/conservation assertion";

await db.close();
console.log("W08_FINANCIAL_EVIDENCE " + JSON.stringify({ ...evidence, fail: fail || null }));
if (fail) {
  console.error("W08_FINANCIAL_DRILL_FAILED: " + fail);
  process.exit(1);
}
console.log("W08_FINANCIAL_DRILL_OK");

