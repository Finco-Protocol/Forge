import { serializeSignature, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { ROBINHOOD_CHAIN_ID } from "../config";
import type { DigestSigner } from "./types";

/**
 * TEST-ONLY in-process key. Refuses to exist for chain 4663 or in a
 * production build: a production eligibility authority requires separately
 * configured KMS/HSM custody and owner approval (docs/W03-SECURITY-RUNBOOK.md).
 */
export class LocalTestDigestSigner implements DigestSigner {
  readonly custody = "local-test" as const;
  readonly address;
  constructor(
    readonly role: "authority" | "evidence",
    private readonly privateKey: Hex,
    opts: { chainId: number; production: boolean },
  ) {
    if (opts.chainId === ROBINHOOD_CHAIN_ID) throw new Error("PRODUCTION_BLOCKED: local-test signer refused for chain 4663.");
    if (opts.production) throw new Error("PRODUCTION_BLOCKED: local-test signer refused when NODE_ENV=production.");
    this.address = privateKeyToAccount(privateKey).address;
  }
  async signDigest(digest: Hex): Promise<Hex> {
    const sig = await sign({ hash: digest, privateKey: this.privateKey });
    return serializeSignature(sig);
  }
}
