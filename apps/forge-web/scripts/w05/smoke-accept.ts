/**
 * Acceptance logic for the negative deploy smoke tests S09 / S10 (pure functions, unit-tested with negative cases).
 *
 * A smoke test that expects a revert may only pass when the revert is the EXACT expected custom error, raised by the
 * call that was actually intended: right target, right calldata, decodable revert data. Anything else - no revert,
 * empty revert data, an unrelated ABI error, an error wrapped for a different contract, an out-of-gas / intrinsic-gas
 * or transport failure, a malformed response - is a rejection (fail closed).
 */
import { decodeAbiParameters, getAddress, isAddress, parseAbiParameters, toFunctionSelector, type Hex } from "viem";

export interface RpcCall {
  to: string;
  data: string;
  from?: string;
}
export interface RpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}
export type Verdict = { ok: true; detail: string } | { ok: false; detail: string };

const GAS_OR_FUNDS = /out of gas|gas required exceeds|intrinsic gas|gas limit|insufficient funds|exceeds (block )?gas/i;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** Extract the revert data of a JSON-RPC eth_call failure, or explain why there is none. */
export function extractRevertData(resp: RpcResponse | undefined): { ok: true; data: Hex } | { ok: false; detail: string } {
  if (!resp || typeof resp !== "object") return { ok: false, detail: "no or malformed JSON-RPC response (transport failure)" };
  const e = resp.error;
  if (!e) return { ok: false, detail: "call did not revert" };
  const msg = String(e.message ?? "");
  if (GAS_OR_FUNDS.test(msg)) return { ok: false, detail: `gas/funds failure, not an access-control revert: ${msg.slice(0, 120)}` };
  let d: unknown = e.data;
  if (d && typeof d === "object" && "data" in d) d = (d as { data: unknown }).data; // nested provider shape
  if (typeof d !== "string" || !HEX.test(d)) return { ok: false, detail: `no revert data (code ${e.code ?? "?"}: ${msg.slice(0, 120) || "no message"})` };
  if (d.length < 10) return { ok: false, detail: "empty or truncated revert data (no custom-error selector)" };
  return { ok: true, data: d.toLowerCase() as Hex };
}

function sameCall(req: RpcCall, want: RpcCall): string | null {
  if (!isAddress(req.to) || getAddress(req.to) !== getAddress(want.to)) return `eth_call target ${req.to} is not the intended contract ${want.to}`;
  if (req.data.toLowerCase() !== want.data.toLowerCase()) return "eth_call calldata is not the intended call";
  return null;
}

/** S09: an unauthorized launchToken must fail with exactly `expectedRevert` (selector + encoded args), from the factory call. */
export function acceptS09(sent: RpcCall, intended: RpcCall, resp: RpcResponse | undefined, expectedRevert: Hex): Verdict {
  const wrong = sameCall(sent, intended);
  if (wrong) return { ok: false, detail: wrong };
  const r = extractRevertData(resp);
  if (!r.ok) return { ok: false, detail: r.detail };
  if (r.data !== expectedRevert.toLowerCase()) return { ok: false, detail: `unexpected revert ${r.data.slice(0, 74)} (expected ${expectedRevert})` };
  return { ok: true, detail: `unauthorized launch reverted with the expected error ${r.data.slice(0, 10)} (data matches exactly)` };
}

export interface S10Expect {
  /** PoolManager address the eth_call must target */
  poolManager: string;
  /** the Forge hook that must be the source of the refusal */
  hook: string;
  /** exact selector of the hook callback that refused (IHooks.beforeInitialize) */
  hookCallbackSelector: Hex;
  /** exact selector of the hook custom error expected (NotFactory()) */
  hookErrorSelector: Hex;
}
export const WRAPPED_ERROR = toFunctionSelector("function WrappedError(address,bytes4,bytes,bytes)");

/** S10: PoolManager.initialize from a non-factory must be refused by the Forge hook (WrappedError from that hook, expected inner error). */
export function acceptS10(sent: RpcCall, intended: RpcCall, resp: RpcResponse | undefined, x: S10Expect): Verdict {
  if (!isAddress(intended.to) || getAddress(intended.to) !== getAddress(x.poolManager)) return { ok: false, detail: "intended call is not addressed to the PoolManager" };
  const wrong = sameCall(sent, intended);
  if (wrong) return { ok: false, detail: wrong };
  const r = extractRevertData(resp);
  if (!r.ok) return { ok: false, detail: r.detail };
  if (!r.data.startsWith(WRAPPED_ERROR.toLowerCase())) return { ok: false, detail: `revert ${r.data.slice(0, 10)} is not the PoolManager hook WrappedError` };
  let target: string, callback: string, reason: string;
  try {
    [target, callback, reason] = decodeAbiParameters(parseAbiParameters("address, bytes4, bytes, bytes"), `0x${r.data.slice(10)}` as Hex) as [string, string, string, string];
  } catch {
    return { ok: false, detail: "WrappedError payload does not decode" };
  }
  if (getAddress(target) !== getAddress(x.hook)) return { ok: false, detail: `refusal came from ${target}, not the Forge hook ${x.hook}` };
  if (callback.toLowerCase() !== x.hookCallbackSelector.toLowerCase()) return { ok: false, detail: `refusing callback ${callback} is not the expected ${x.hookCallbackSelector}` };
  if (reason.slice(0, 10).toLowerCase() !== x.hookErrorSelector.toLowerCase()) return { ok: false, detail: `hook error ${reason.slice(0, 10)} is not the expected ${x.hookErrorSelector}` };
  return { ok: true, detail: `refused by the Forge hook ${target}: ${callback} -> ${reason.slice(0, 10)}` };
}

/** Raw eth_call that never throws: a fetch/JSON failure becomes `undefined` (a transport failure that every acceptor rejects). */
export async function rawEthCall(rpcUrl: string, call: RpcCall): Promise<RpcResponse | undefined> {
  try {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }) });
    if (!r.ok) return undefined;
    return (await r.json()) as RpcResponse;
  } catch {
    return undefined;
  }
}
