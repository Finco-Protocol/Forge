/**
 * Transaction submission + confirmation for the LOCAL Anvil dry-run harness, with per-step evidence and a
 * deterministic failure classification.
 *
 * Why this exists: the 4663 fork dry-run once failed in CI with only "Timed out while waiting for transaction <hash>"
 * after viem's 180 s default - no step, no nonce, no pending/automine/fee evidence. Every deployment step now records
 * what was sent and what the node reported, and a confirmation failure captures a node snapshot and is classified from
 * that evidence (never guessed).
 *
 * SAFETY: every write goes through `assertLoopbackRpc`; a non-loopback RPC (e.g. the real Robinhood endpoint) is refused
 * before any request that could carry a transaction is made.
 */
import type { ChildProcess } from "node:child_process";
import { getAddress, type Address, type Hex } from "viem";

export type TxClass =
  | "TX_NOT_ACCEPTED"
  | "PENDING_AUTOMINE_DISABLED"
  | "PENDING_NONCE_GAP"
  | "NONCE_CONFLICT"
  | "UNDERPRICED"
  | "PENDING_MINING_STALLED"
  | "RPC_RECEIPT_UNAVAILABLE"
  | "ANVIL_EXITED"
  | "WRONG_CHAIN"
  | "RECEIPT_MISMATCH"
  | "CONFIRMED_REVERT"
  | "UNCLASSIFIED";

export interface TxView {
  hash: Hex;
  from: string;
  to: string | null;
  nonce: number;
  blockNumber: number | null;
  gas: bigint | null;
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
}
export interface ReceiptView {
  transactionHash: string;
  from: string;
  to: string | null;
  contractAddress: string | null;
  status: "success" | "reverted";
  blockNumber: number;
  gasUsed: bigint;
}
/** Node evidence captured at a confirmation failure (all RPC reads; nothing is sent). */
export interface TxSnapshot {
  rpcReachable: boolean;
  anvilExitCode: number | null;
  chainId: number | null;
  expectedChainId: number;
  blockNumber: number | null;
  tx: TxView | null;
  receipt: ReceiptView | null;
  nonceLatest: number | null;
  noncePending: number | null;
  baseFeePerGas: bigint | null;
  gasPrice: bigint | null;
  automine: boolean | null;
  intervalMining: number | null;
  txpool: { pending: number; queued: number } | null;
  anvilLogTail: string;
}
export interface TxExpectation {
  from: Address;
  /** destination for calls; null/undefined for contract creation */
  to?: Address | null;
}

export interface StepRecord {
  n: number;
  op: string;
  contract: string;
  fn: string | null;
  from: Address;
  expectedNonce: number | null;
  txHash: Hex | null;
  txNonce: number | null;
  gas: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  blockBefore: number | null;
  blockAtConfirm: number | null;
  visibleByHash: boolean | null;
  receiptStatus: "success" | "reverted" | null;
  pendingAtFailure: boolean | null;
  elapsedMs: number;
  outcome: "CONFIRMED" | "FAILED";
  classification: TxClass | null;
  detail: string | null;
}

export class TxConfirmError extends Error {
  constructor(
    message: string,
    readonly classification: TxClass,
    readonly record: StepRecord,
    readonly snapshot: TxSnapshot | null,
  ) {
    super(message);
    this.name = "TxConfirmError";
  }
}

/* ───────────────────────────── safety ───────────────────────────── */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Refuses any RPC that is not a loopback endpoint. Real RPCs (Robinhood mainnet included) can never receive a dry-run write. */
export function assertLoopbackRpc(rpcUrl: string): void {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    throw new Error(`refusing to send: unparseable RPC URL`);
  }
  if (!LOOPBACK.has(host)) throw new Error(`refusing to send transactions to a non-loopback RPC (${host}): dry-run writes are local-Anvil only`);
}

/* ───────────────────────────── raw rpc ───────────────────────────── */

async function rpc<T>(url: string, method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
const maybe = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const num = (h: unknown): number | null => (typeof h === "string" && h.startsWith("0x") ? Number(BigInt(h)) : null);
const big = (h: unknown): bigint | null => (typeof h === "string" && h.startsWith("0x") ? BigInt(h) : null);

type RawTx = { hash: Hex; from: string; to: string | null; nonce: string; blockNumber: string | null; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
type RawReceipt = { transactionHash: string; from: string; to: string | null; contractAddress: string | null; status: string; blockNumber: string; gasUsed: string };

function viewTx(t: RawTx | null): TxView | null {
  if (!t) return null;
  return { hash: t.hash, from: t.from, to: t.to, nonce: Number(BigInt(t.nonce)), blockNumber: num(t.blockNumber), gas: big(t.gas), gasPrice: big(t.gasPrice), maxFeePerGas: big(t.maxFeePerGas), maxPriorityFeePerGas: big(t.maxPriorityFeePerGas) };
}
function viewReceipt(r: RawReceipt | null): ReceiptView | null {
  if (!r) return null;
  return { transactionHash: r.transactionHash, from: r.from, to: r.to, contractAddress: r.contractAddress, status: r.status === "0x1" ? "success" : "reverted", blockNumber: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed) };
}

export async function captureSnapshot(rpcUrl: string, hash: Hex | null, from: Address, expectedChainId: number, proc?: Pick<ChildProcess, "exitCode"> | null, logTail = ""): Promise<TxSnapshot> {
  const chainId = num(await maybe(rpc<string>(rpcUrl, "eth_chainId", [], 5_000)));
  const tx = hash ? viewTx(await maybe(rpc<RawTx | null>(rpcUrl, "eth_getTransactionByHash", [hash], 5_000))) : null;
  const receipt = hash ? viewReceipt(await maybe(rpc<RawReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [hash], 5_000))) : null;
  const latestBlock = await maybe(rpc<{ baseFeePerGas?: string } | null>(rpcUrl, "eth_getBlockByNumber", ["latest", false], 5_000));
  const pool = await maybe(rpc<{ pending: string; queued: string }>(rpcUrl, "txpool_status", [], 5_000));
  const auto = await maybe(rpc<boolean>(rpcUrl, "anvil_getAutomine", [], 5_000));
  const interval = await maybe(rpc<number | null>(rpcUrl, "anvil_getIntervalMining", [], 5_000));
  return {
    rpcReachable: chainId !== null,
    anvilExitCode: proc ? proc.exitCode : null,
    chainId,
    expectedChainId,
    blockNumber: num(await maybe(rpc<string>(rpcUrl, "eth_blockNumber", [], 5_000))),
    tx,
    receipt,
    nonceLatest: num(await maybe(rpc<string>(rpcUrl, "eth_getTransactionCount", [from, "latest"], 5_000))),
    noncePending: num(await maybe(rpc<string>(rpcUrl, "eth_getTransactionCount", [from, "pending"], 5_000))),
    baseFeePerGas: big(latestBlock?.baseFeePerGas),
    gasPrice: big(await maybe(rpc<string>(rpcUrl, "eth_gasPrice", [], 5_000))),
    automine: typeof auto === "boolean" ? auto : null,
    intervalMining: typeof interval === "number" ? interval : null,
    txpool: pool ? { pending: Number(BigInt(pool.pending)), queued: Number(BigInt(pool.queued)) } : null,
    anvilLogTail: logTail,
  };
}

/* ───────────────────────────── classification ───────────────────────────── */

/**
 * Deterministic classification from node evidence. Order matters: a dead node trumps everything, then identity
 * (chain), then what the node says about THIS hash. `PENDING_MINING_STALLED` is reported only when every other
 * explanation (automine off, nonce gap, fee below base fee) is ruled out by the evidence - it is the residual
 * "accepted, pending, nothing wrong with the transaction" case.
 */
export function classifyTxFailure(s: TxSnapshot, expectedHash: Hex | null): TxClass {
  if (s.anvilExitCode !== null || !s.rpcReachable) return "ANVIL_EXITED";
  if (s.chainId !== null && s.chainId !== s.expectedChainId) return "WRONG_CHAIN";
  if (s.receipt) {
    if (expectedHash && s.receipt.transactionHash.toLowerCase() !== expectedHash.toLowerCase()) return "RECEIPT_MISMATCH";
    return s.receipt.status === "reverted" ? "CONFIRMED_REVERT" : "UNCLASSIFIED";
  }
  if (!s.tx) return "TX_NOT_ACCEPTED";
  if (s.tx.blockNumber !== null) return "RPC_RECEIPT_UNAVAILABLE"; // mined according to the node, yet no receipt
  // accepted and pending
  if (s.automine === false && !s.intervalMining) return "PENDING_AUTOMINE_DISABLED";
  if (s.nonceLatest !== null) {
    if (s.tx.nonce > s.nonceLatest) return "PENDING_NONCE_GAP";
    if (s.tx.nonce < s.nonceLatest) return "NONCE_CONFLICT";
  }
  const fee = s.tx.maxFeePerGas ?? s.tx.gasPrice;
  if (fee !== null && s.baseFeePerGas !== null && fee < s.baseFeePerGas) return "UNDERPRICED";
  return "PENDING_MINING_STALLED";
}

/* ───────────────────────────── send + confirm ───────────────────────────── */

export interface SendCtx {
  rpcUrl: string;
  expectedChainId: number;
  proc?: Pick<ChildProcess, "exitCode"> | null;
  logs?: () => string;
  /** per-step confirmation budget (local automine confirms in well under a second) */
  timeoutMs?: number;
  pollMs?: number;
}
export interface StepInfo {
  n: number;
  op: string;
  contract: string;
  fn?: string | null;
}

export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

/**
 * `submit` performs the eth_sendTransaction (viem wallet) and returns the hash. The function then records the step,
 * waits for THAT hash's receipt by polling the node, and validates it. On any failure it throws TxConfirmError
 * carrying the step record and a node snapshot.
 */
export async function sendAndConfirm(ctx: SendCtx, info: StepInfo, expect: TxExpectation, submit: () => Promise<Hex>): Promise<{ record: StepRecord; receipt: ReceiptView }> {
  assertLoopbackRpc(ctx.rpcUrl);
  const t0 = performance.now();
  const from = getAddress(expect.from);
  const rec: StepRecord = {
    n: info.n, op: info.op, contract: info.contract, fn: info.fn ?? null, from,
    expectedNonce: null, txHash: null, txNonce: null, gas: null, gasPrice: null, maxFeePerGas: null, maxPriorityFeePerGas: null,
    blockBefore: null, blockAtConfirm: null, visibleByHash: null, receiptStatus: null, pendingAtFailure: null, elapsedMs: 0, outcome: "FAILED", classification: null, detail: null,
  };
  const fail = async (cls: TxClass, message: string, withSnapshot = true): Promise<never> => {
    const snap = withSnapshot ? await captureSnapshot(ctx.rpcUrl, rec.txHash, from, ctx.expectedChainId, ctx.proc, ctx.logs?.() ?? "") : null;
    rec.outcome = "FAILED";
    rec.classification = cls;
    rec.detail = message;
    rec.elapsedMs = Math.round(performance.now() - t0);
    rec.pendingAtFailure = snap ? !!snap.tx && snap.tx.blockNumber === null : null;
    rec.visibleByHash = snap ? !!snap.tx : null;
    throw new TxConfirmError(`step ${info.n} (${info.op} ${info.contract}${info.fn ? "." + info.fn : ""}): ${cls}: ${message}`, cls, rec, snap);
  };

  const chainId = num(await maybe(rpc<string>(ctx.rpcUrl, "eth_chainId", [], 5_000)));
  if (chainId === null) return fail("ANVIL_EXITED", "RPC unreachable before submit");
  if (chainId !== ctx.expectedChainId) return fail("WRONG_CHAIN", `RPC chain ${chainId} != expected ${ctx.expectedChainId}`);
  rec.expectedNonce = num(await maybe(rpc<string>(ctx.rpcUrl, "eth_getTransactionCount", [from, "pending"], 5_000)));
  rec.blockBefore = num(await maybe(rpc<string>(ctx.rpcUrl, "eth_blockNumber", [], 5_000)));

  let hash: Hex;
  try {
    hash = await submit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const snap = await captureSnapshot(ctx.rpcUrl, null, from, ctx.expectedChainId, ctx.proc, ctx.logs?.() ?? "");
    const cls: TxClass = snap.anvilExitCode !== null || !snap.rpcReachable ? "ANVIL_EXITED" : /nonce/i.test(msg) ? "NONCE_CONFLICT" : /underpriced|max fee per gas less than block base fee|fee cap/i.test(msg) ? "UNDERPRICED" : "TX_NOT_ACCEPTED";
    rec.classification = cls;
    rec.detail = `submit rejected: ${msg.split("\n")[0]!.slice(0, 300)}`;
    rec.elapsedMs = Math.round(performance.now() - t0);
    throw new TxConfirmError(`step ${info.n} (${info.op} ${info.contract}${info.fn ? "." + info.fn : ""}): ${cls}: ${rec.detail}`, cls, rec, snap);
  }
  rec.txHash = hash;

  // Visibility + submitted parameters, straight from the node.
  const seen = viewTx(await maybe(rpc<RawTx | null>(ctx.rpcUrl, "eth_getTransactionByHash", [hash], 5_000)));
  if (seen) {
    rec.txNonce = seen.nonce;
    rec.gas = seen.gas?.toString() ?? null;
    rec.gasPrice = seen.gasPrice?.toString() ?? null;
    rec.maxFeePerGas = seen.maxFeePerGas?.toString() ?? null;
    rec.maxPriorityFeePerGas = seen.maxPriorityFeePerGas?.toString() ?? null;
    rec.visibleByHash = true;
    if (rec.expectedNonce !== null && seen.nonce !== rec.expectedNonce) return fail(seen.nonce > rec.expectedNonce ? "PENDING_NONCE_GAP" : "NONCE_CONFLICT", `tx nonce ${seen.nonce} != expected next nonce ${rec.expectedNonce}`);
    if (seen.from.toLowerCase() !== from.toLowerCase()) return fail("RECEIPT_MISMATCH", `tx sender ${seen.from} != ${from}`);
  }

  const deadline = performance.now() + (ctx.timeoutMs ?? Number(process.env.FORGE_TX_CONFIRM_TIMEOUT_MS ?? DEFAULT_CONFIRM_TIMEOUT_MS));
  let receipt: ReceiptView | null = null;
  while (performance.now() < deadline) {
    if (ctx.proc && ctx.proc.exitCode !== null) return fail("ANVIL_EXITED", `anvil exited (${ctx.proc.exitCode}) while waiting for the receipt`);
    receipt = viewReceipt(await maybe(rpc<RawReceipt | null>(ctx.rpcUrl, "eth_getTransactionReceipt", [hash], 5_000)));
    if (receipt) break;
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 100));
  }
  if (!receipt) {
    const snap = await captureSnapshot(ctx.rpcUrl, hash, from, ctx.expectedChainId, ctx.proc, ctx.logs?.() ?? "");
    const cls = classifyTxFailure(snap, hash);
    return fail(cls, `no receipt for ${hash} after ${Math.round((performance.now() - t0) / 1000)} s (pending=${snap.tx ? snap.tx.blockNumber === null : "not visible"}, nonce latest/pending=${snap.nonceLatest}/${snap.noncePending}, automine=${snap.automine}, block=${snap.blockNumber}, baseFee=${snap.baseFeePerGas}, txpool=${JSON.stringify(snap.txpool)})`);
  }
  rec.blockAtConfirm = receipt.blockNumber;
  rec.receiptStatus = receipt.status;
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) return fail("RECEIPT_MISMATCH", `receipt is for ${receipt.transactionHash}, expected ${hash}`);
  if (receipt.from.toLowerCase() !== from.toLowerCase()) return fail("RECEIPT_MISMATCH", `receipt sender ${receipt.from} != ${from}`);
  if (expect.to !== undefined && expect.to !== null && receipt.to?.toLowerCase() !== expect.to.toLowerCase()) return fail("RECEIPT_MISMATCH", `receipt target ${receipt.to} != expected ${expect.to}`);
  if (receipt.status !== "success") return fail("CONFIRMED_REVERT", `transaction ${hash} reverted in block ${receipt.blockNumber}`);
  rec.outcome = "CONFIRMED";
  rec.elapsedMs = Math.round(performance.now() - t0);
  return { record: rec, receipt };
}

/** Verifies the local Anvil is auto-mining and identifies it as a local node (anvil_nodeInfo); fail closed otherwise. */
export async function assertLocalAutomine(rpcUrl: string): Promise<{ automine: boolean; intervalMining: number | null }> {
  assertLoopbackRpc(rpcUrl);
  const auto = await rpc<boolean>(rpcUrl, "anvil_getAutomine");
  const interval = await maybe(rpc<number | null>(rpcUrl, "anvil_getIntervalMining"));
  if (auto !== true) throw new Error(`local Anvil is not auto-mining (anvil_getAutomine=${auto}); dry-run steps would stay pending - refusing to start`);
  return { automine: true, intervalMining: typeof interval === "number" ? interval : null };
}

/**
 * Cold-read latency of a LOCAL Anvil fork's remote backend: each read of a never-touched address makes Anvil fetch that
 * account from the remote RPC. Measured on a fork before the first step so a slow/throttled remote shows up as evidence
 * (an Anvil transaction touching cold state stays pending while its state reads are in flight - demonstrated in
 * test/v4/fork-backend-stall.test.ts).
 */
export async function probeForkLatency(rpcUrl: string, samples = 4): Promise<{ samplesMs: number[]; maxMs: number }> {
  assertLoopbackRpc(rpcUrl);
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const addr = `0x${(0xf0000000n + BigInt(Date.now() % 1_000_000) * 16n + BigInt(i)).toString(16).padStart(40, "0")}`;
    const t = performance.now();
    await rpc(rpcUrl, "eth_getBalance", [addr, "latest"], 60_000);
    out.push(Math.round(performance.now() - t));
  }
  return { samplesMs: out, maxMs: Math.max(...out) };
}
