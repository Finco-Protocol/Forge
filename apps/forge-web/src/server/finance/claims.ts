/**
 * W04 Correction A — claim transaction attestation.
 *
 * A reported claim hash is evidence only once its CONTENTS are proven: the
 * chain, the sender (the session's bound wallet), the canonical recipient
 * contract, the exact selector, the ABI-decoded asset and nominal amount
 * (0 / no-amount variant = full balance) and a zero value. Success further
 * requires a successful receipt AND the canonical indexed claim event.
 */
import { decodeFunctionData, getAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { forgeProtocolRevenueSplitterAbi, ponsV2FeeEscrowAbi } from "@/shared/abis.generated";
import { NATIVE } from "./ledger";

export type ClaimKind = "escrow" | "treasury";

/** Exactly the claim entry points a submission may name, per kind. */
const CLAIM_SIGNATURES: Record<ClaimKind, string[]> = {
  escrow: ["claim()", "claim(uint256)", "claimToken(address)", "claimToken(address,uint256)"],
  treasury: ["claimTreasury(address,uint256)"],
};
export const CLAIM_SELECTORS: Record<ClaimKind, Record<Hex, string>> = {
  escrow: Object.fromEntries(CLAIM_SIGNATURES.escrow.map((sig) => [toFunctionSelector(sig), sig])),
  treasury: Object.fromEntries(CLAIM_SIGNATURES.treasury.map((sig) => [toFunctionSelector(sig), sig])),
};

export interface ExpectedClaim {
  chainId: number;
  wallet: Address;
  kind: ClaimKind;
  asset: Address;
  target: Address;
  /** Expected nominal amount (0 = full balance); null = not asserted by the caller. */
  nominal: bigint | null;
}

export interface ClaimTx {
  chainId?: number;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
}

export type ClaimContentCheck =
  | { ok: true; selector: Hex; signature: string; asset: Address; nominal: bigint }
  | { ok: false; code: ClaimRejection; reason: string };

export type ClaimRejection =
  | "WRONG_CHAIN"
  | "NOT_YOUR_TRANSACTION"
  | "WRONG_RECIPIENT_CONTRACT"
  | "WRONG_SELECTOR"
  | "WRONG_ASSET"
  | "WRONG_AMOUNT"
  | "UNEXPECTED_VALUE";

export function verifyClaimContents(tx: ClaimTx, exp: ExpectedClaim): ClaimContentCheck {
  if (tx.chainId !== undefined && tx.chainId !== exp.chainId) return { ok: false, code: "WRONG_CHAIN", reason: `Transaction is for chain ${tx.chainId}, not ${exp.chainId}.` };
  if (getAddress(tx.from) !== exp.wallet) return { ok: false, code: "NOT_YOUR_TRANSACTION", reason: "That transaction was not sent by your wallet." };
  if (!tx.to || getAddress(tx.to) !== exp.target) {
    return { ok: false, code: "WRONG_RECIPIENT_CONTRACT", reason: `Transaction targets ${tx.to ?? "a contract creation"}, not the canonical ${exp.kind === "escrow" ? "fee escrow" : "revenue splitter"} ${exp.target}.` };
  }
  const selector = tx.input.slice(0, 10).toLowerCase() as Hex;
  const signature = CLAIM_SELECTORS[exp.kind][selector];
  if (!signature) return { ok: false, code: "WRONG_SELECTOR", reason: `Selector ${selector} is not a ${exp.kind} claim entry point.` };
  let asset: Address;
  let nominal: bigint;
  try {
    if (exp.kind === "escrow") {
      const d = decodeFunctionData({ abi: ponsV2FeeEscrowAbi, data: tx.input });
      const args = (d.args ?? []) as readonly unknown[];
      if (d.functionName === "claim") {
        asset = NATIVE;
        nominal = args.length === 1 ? (args[0] as bigint) : 0n;
      } else if (d.functionName === "claimToken") {
        asset = getAddress(args[0] as Address);
        nominal = args.length === 2 ? (args[1] as bigint) : 0n;
      } else {
        return { ok: false, code: "WRONG_SELECTOR", reason: `${d.functionName} is not a claim.` };
      }
    } else {
      const d = decodeFunctionData({ abi: forgeProtocolRevenueSplitterAbi, data: tx.input });
      if (d.functionName !== "claimTreasury") return { ok: false, code: "WRONG_SELECTOR", reason: `${d.functionName} is not a treasury claim.` };
      const args = d.args as readonly [Address, bigint];
      asset = getAddress(args[0]);
      nominal = args[1];
    }
  } catch {
    return { ok: false, code: "WRONG_SELECTOR", reason: "Calldata does not ABI-decode as a claim." };
  }
  if (asset !== exp.asset) return { ok: false, code: "WRONG_ASSET", reason: `Transaction claims ${asset}, not ${exp.asset}.` };
  if (exp.nominal !== null && nominal !== exp.nominal) {
    return { ok: false, code: "WRONG_AMOUNT", reason: `Transaction claims ${nominal === 0n ? "the full balance" : nominal.toString()}, not ${exp.nominal === 0n ? "the full balance" : exp.nominal.toString()}.` };
  }
  if (tx.value !== 0n) return { ok: false, code: "UNEXPECTED_VALUE", reason: "A claim never carries value." };
  return { ok: true, selector, signature, asset, nominal };
}
