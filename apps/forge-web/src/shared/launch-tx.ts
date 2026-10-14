import type { Address, Hex } from "viem";
import { launchAuthorizationTypes, type Socials } from "./forge-typed-data";

/** JSON (strings) → viem args for PonsV2LaunchFactory.launchToken(TokenParams, uint256, address, address[]). */
export interface LaunchTxJson {
  address: Address;
  functionName: "launchToken";
  args: [Record<string, unknown>, string, Address, Address[]];
  value: string;
  chainId: number;
}

export function reviveLaunchArgs(tx: LaunchTxJson) {
  const p = tx.args[0] as Record<string, string | number | boolean | Socials>;
  const params = {
    name: String(p.name),
    symbol: String(p.symbol),
    logo: String(p.logo),
    description: String(p.description),
    socials: p.socials as Socials,
    creatorFeeRecipient: p.creatorFeeRecipient as Address,
    creatorTaxBps: Number(p.creatorTaxBps),
    buybackEnabled: Boolean(p.buybackEnabled),
    expectedEconomics: p.expectedEconomics as Hex,
    salt: p.salt as Hex,
    githubRepoId: BigInt(p.githubRepoId as string),
    authorizationExpiresAt: BigInt(p.authorizationExpiresAt as string),
    authorizationNonce: BigInt(p.authorizationNonce as string),
    creatorSignature: p.creatorSignature as Hex,
    attestationPayload: p.attestationPayload as Hex,
  };
  return { params, launchConfigId: BigInt(tx.args[1]), pairToken: tx.args[2], exemptions: tx.args[3], value: BigInt(tx.value) };
}

/**
 * Reconstructs typed data (bigints) from the API's JSON for wallet signing.
 * The TYPES are always the client's own canonical copy, never the server's.
 */
export function reviveTypedData(t: { domain: Record<string, unknown>; message: Record<string, unknown> }) {
  const m = t.message;
  return {
    domain: {
      name: String(t.domain.name),
      version: String(t.domain.version),
      chainId: Number(t.domain.chainId),
      verifyingContract: t.domain.verifyingContract as Address,
    },
    types: launchAuthorizationTypes,
    primaryType: "LaunchAuthorization" as const,
    message: {
      factory: m.factory as Address,
      creator: m.creator as Address,
      githubRepoId: BigInt(m.githubRepoId as string),
      launchConfigId: BigInt(m.launchConfigId as string),
      pairToken: m.pairToken as Address,
      tokenMetadataHash: m.tokenMetadataHash as Hex,
      economicsDigest: m.economicsDigest as Hex,
      salt: m.salt as Hex,
      expiresAt: BigInt(m.expiresAt as string),
      nonce: BigInt(m.nonce as string),
      creatorTaxBps: Number(m.creatorTaxBps),
      exemptionListHash: m.exemptionListHash as Hex,
    },
  };
}
