/** Negative regression tests: invalid errors must FAIL the S09/S10 smoke-test acceptance (fail closed). */
import { describe, expect, it } from "vitest";
import { concat, encodeAbiParameters, getAddress, toFunctionSelector, toHex, type Hex } from "viem";
import { acceptS09, acceptS10, extractRevertData, rawEthCall, WRAPPED_ERROR, type RpcCall, type RpcResponse } from "../../scripts/w05/smoke-accept";

const FACTORY = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const PM = "0x3333333333333333333333333333333333333333";
const HOOK = "0x4444444444444444444444444444444444444444";
const call = (to: string, data = "0xabcdef"): RpcCall => ({ from: "0x000000000000000000000000000000000000dEaD", to, data });
const revert = (data: unknown): RpcResponse => ({ error: { code: 3, message: "execution reverted", data } });

const EXPECTED_09 = concat(["0xfce698f7", toHex(0n, { size: 32 })]);
describe("S09 acceptance", () => {
  const sent = call(FACTORY);
  it("accepts exactly the expected revert from the intended call", () => {
    expect(acceptS09(sent, sent, revert(EXPECTED_09), EXPECTED_09).ok).toBe(true);
  });
  it.each<[string, RpcResponse | undefined]>([
    ["no revert (call succeeded)", { result: "0x" }],
    ["revert with no data", { error: { code: 3, message: "execution reverted" } }],
    ["revert with empty data 0x", revert("0x")],
    ["revert data that is not hex", revert("nope")],
    ["unrelated ABI error (Error(string))", revert("0x08c379a0" + "00".repeat(64))],
    ["right selector, wrong argument (ECDSAInvalidSignatureLength(65))", revert(concat(["0xfce698f7", toHex(65n, { size: 32 })]))],
    ["right selector with trailing garbage", revert(EXPECTED_09 + "00")],
    ["insufficient gas", { error: { code: -32000, message: "out of gas" } }],
    ["intrinsic gas too low", { error: { code: -32000, message: "intrinsic gas too low" } }],
    ["insufficient funds", { error: { code: -32000, message: "insufficient funds for gas * price + value" } }],
    ["transport failure (no response)", undefined],
  ])("rejects: %s", (_n, resp) => {
    expect(acceptS09(sent, sent, resp, EXPECTED_09).ok).toBe(false);
  });
  it("rejects a call sent to the wrong contract even with the right revert data", () => {
    expect(acceptS09(call(OTHER), call(FACTORY), revert(EXPECTED_09), EXPECTED_09).ok).toBe(false);
  });
  it("rejects different calldata (not the intended launch call)", () => {
    expect(acceptS09(call(FACTORY, "0x00"), call(FACTORY), revert(EXPECTED_09), EXPECTED_09).ok).toBe(false);
  });
  it("tolerates nested provider shape error.data.data", () => {
    expect(acceptS09(sent, sent, revert({ data: EXPECTED_09 }), EXPECTED_09).ok).toBe(true);
  });
});

const BEFORE = toFunctionSelector("function beforeInitialize(address,(address,address,uint24,int24,address),uint160)");
const NOT_FACTORY = toFunctionSelector("function NotFactory()");
const x = { poolManager: PM, hook: HOOK, hookCallbackSelector: BEFORE, hookErrorSelector: NOT_FACTORY };
const wrapped = (target: string, cb: Hex, reason: Hex): Hex =>
  concat([WRAPPED_ERROR, encodeAbiParameters([{ type: "address" }, { type: "bytes4" }, { type: "bytes" }, { type: "bytes" }], [getAddress(target), cb, reason, "0x"])]);

describe("S10 acceptance", () => {
  const sent = call(PM);
  it("accepts the hook's NotFactory refusal wrapped by the PoolManager", () => {
    expect(acceptS10(sent, sent, revert(wrapped(HOOK, BEFORE, NOT_FACTORY)), x).ok).toBe(true);
  });
  it.each<[string, RpcResponse | undefined]>([
    ["no revert", { result: "0x" }],
    ["missing revert data", { error: { code: 3, message: "execution reverted" } }],
    ["bare hook error without PoolManager wrapping", revert(NOT_FACTORY)],
    ["wrapped error from a DIFFERENT contract", revert(wrapped(OTHER, BEFORE, NOT_FACTORY))],
    ["wrapped, correct hook, unrelated hook error (UnknownPool)", revert(wrapped(HOOK, BEFORE, toFunctionSelector("function UnknownPool()")))],
    ["wrapped, correct hook and error, wrong callback", revert(wrapped(HOOK, "0xdeadbeef", NOT_FACTORY))],
    ["WrappedError with a truncated payload", revert(concat([WRAPPED_ERROR, "0x1234"]))],
    ["unrelated PoolManager error (PoolAlreadyInitialized)", revert(toFunctionSelector("function PoolAlreadyInitialized()"))],
    ["insufficient gas", { error: { code: -32000, message: "gas required exceeds allowance (30000000)" } }],
    ["transport failure", undefined],
  ])("rejects: %s", (_n, resp) => {
    expect(acceptS10(sent, sent, resp, x).ok).toBe(false);
  });
  it("rejects when the intended call is not addressed to the PoolManager, or the sent call differs", () => {
    expect(acceptS10(call(OTHER), call(OTHER), revert(wrapped(HOOK, BEFORE, NOT_FACTORY)), x).ok).toBe(false);
    expect(acceptS10(call(PM, "0x01"), call(PM), revert(wrapped(HOOK, BEFORE, NOT_FACTORY)), x).ok).toBe(false);
  });
});

describe("transport handling", () => {
  it("extractRevertData rejects malformed responses", () => {
    expect(extractRevertData(undefined).ok).toBe(false);
    expect(extractRevertData({} as RpcResponse).ok).toBe(false);
    expect(extractRevertData(revert("0x1234")).ok).toBe(false); // < 4-byte selector
  });
  it("rawEthCall maps an unreachable RPC to undefined (which every acceptor rejects)", async () => {
    expect(await rawEthCall("http://127.0.0.1:1", call(FACTORY))).toBeUndefined();
  });
});
