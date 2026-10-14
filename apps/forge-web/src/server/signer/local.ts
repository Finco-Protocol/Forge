import { serializeSignature, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { ROBINHOOD_CHAIN_ID } from "../config";
import type { DigestSigner } from "./types";

export const LOCAL_DEV_CHAIN_IDS = new Set([31337, 1337]);

/**
 * TEST-ONLY in-process key. Refuses to exist for any chain other than a
 * local dev chain (31337/1337): a real eligibility authority requires
 * separately configured KMS/HSM custody and owner approval
 * (docs/W03-SECURITY-RUNBOOK.md).
 */
export class LocalTestDigestSigner implements DigestSigner {
  readonly custody = "local-test" as const;
  readonly address;
  constructor(
    readonly role: "authority" | "evidence",
    private readonly privateKey: Hex,
    opts: { chainId: number },
  ) {
    if (opts.chainId === ROBINHOOD_CHAIN_ID) throw new Error("PRODUCTION_BLOCKED: local-test signer refused for chain 4663.");
    // Only valueless local dev chains (Anvil/Hardhat). Any other chain requires KMS/HSM custody.
    if (!LOCAL_DEV_CHAIN_IDS.has(opts.chainId)) throw new Error(`PRODUCTION_BLOCKED: local-test signer refused for chain ${opts.chainId} (local dev chains only).`);
    this.address = privateKeyToAccount(privateKey).address;
  }
  async signDigest(digest: Hex): Promise<Hex> {
    const sig = await sign({ hash: digest, privateKey: this.privateKey });
    return serializeSignature(sig);
  }
}
