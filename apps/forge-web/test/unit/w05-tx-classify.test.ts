/** Deterministic classification of a transaction-confirmation failure from node evidence (pure; no node needed). */
import { describe, expect, it } from "vitest";
import { assertLoopbackRpc, classifyTxFailure, type TxSnapshot, type TxView } from "../../scripts/w05/tx-confirm";

const H = `0x${"ab".repeat(32)}` as const;
const tx = (o: Partial<TxView> = {}): TxView => ({ hash: H, from: "0x1", to: "0x2", nonce: 5, blockNumber: null, gas: 100n, gasPrice: null, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n, ...o });
const snap = (o: Partial<TxSnapshot> = {}): TxSnapshot => ({
  rpcReachable: true, anvilExitCode: null, chainId: 4663, expectedChainId: 4663, blockNumber: 100, tx: tx(), receipt: null,
  nonceLatest: 5, noncePending: 6, baseFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n, automine: true, intervalMining: null, txpool: { pending: 1, queued: 0 }, anvilLogTail: "", ...o,
});
const receipt = (o: Record<string, unknown> = {}) => ({ transactionHash: H, from: "0x1", to: "0x2", contractAddress: null, status: "success" as const, blockNumber: 101, gasUsed: 21000n, ...o });

describe("classifyTxFailure - every class is derived from evidence", () => {
  it("accepted + pending + automine disabled", () => expect(classifyTxFailure(snap({ automine: false }), H)).toBe("PENDING_AUTOMINE_DISABLED"));
  it("automine off but interval mining on is not 'disabled'", () => expect(classifyTxFailure(snap({ automine: false, intervalMining: 1 }), H)).not.toBe("PENDING_AUTOMINE_DISABLED"));
  it("pending with a nonce above the account's latest nonce", () => expect(classifyTxFailure(snap({ tx: tx({ nonce: 9 }), nonceLatest: 5 }), H)).toBe("PENDING_NONCE_GAP"));
  it("pending with a nonce below the account's latest nonce", () => expect(classifyTxFailure(snap({ tx: tx({ nonce: 3 }), nonceLatest: 5 }), H)).toBe("NONCE_CONFLICT"));
  it("pending with a fee cap below the base fee", () => expect(classifyTxFailure(snap({ tx: tx({ maxFeePerGas: 10n }) }), H)).toBe("UNDERPRICED"));
  it("pending, automine on, nonce right, fee fine -> residual PENDING_MINING_STALLED", () => expect(classifyTxFailure(snap(), H)).toBe("PENDING_MINING_STALLED"));
  it("node says mined but gives no receipt", () => expect(classifyTxFailure(snap({ tx: tx({ blockNumber: 101 }) }), H)).toBe("RPC_RECEIPT_UNAVAILABLE"));
  it("never seen by hash and no receipt", () => expect(classifyTxFailure(snap({ tx: null }), H)).toBe("TX_NOT_ACCEPTED"));
  it("process exited", () => expect(classifyTxFailure(snap({ anvilExitCode: 137 }), H)).toBe("ANVIL_EXITED"));
  it("rpc unreachable", () => expect(classifyTxFailure(snap({ rpcReachable: false, chainId: null }), H)).toBe("ANVIL_EXITED"));
  it("wrong chain id", () => expect(classifyTxFailure(snap({ chainId: 31337 }), H)).toBe("WRONG_CHAIN"));
  it("receipt for a different transaction", () => expect(classifyTxFailure(snap({ receipt: receipt({ transactionHash: `0x${"cd".repeat(32)}` }) }), H)).toBe("RECEIPT_MISMATCH"));
  it("confirmed revert", () => expect(classifyTxFailure(snap({ receipt: receipt({ status: "reverted" }) }), H)).toBe("CONFIRMED_REVERT"));
  it("a dead node outranks everything else", () => expect(classifyTxFailure(snap({ anvilExitCode: 1, automine: false, chainId: 1 }), H)).toBe("ANVIL_EXITED"));
});

describe("no genuine broadcast is possible", () => {
  it.each(["https://rpc.mainnet.chain.robinhood.com", "http://10.0.0.5:8545", "https://example.com", "http://anvil.internal:8545", "not a url"])("refuses %s", (u) => {
    expect(() => assertLoopbackRpc(u)).toThrow(/refusing to send/);
  });
  it.each(["http://127.0.0.1:8545", "http://localhost:1234"])("allows loopback %s", (u) => {
    expect(() => assertLoopbackRpc(u)).not.toThrow();
  });
});
