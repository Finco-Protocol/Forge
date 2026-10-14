/**
 * EIP-712 / registry compatibility evidence: every digest W03 computes
 * off chain is compared with the deployed W02 contracts' own view functions
 * over randomized inputs (deterministic seed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { forgeBindingRegistryAbi, forgeLaunchAuthorizerAbi } from "@/shared/abis.generated";
import { bindingOpTypes, eligibilityAttestationTypes, launchAuthorizationMessage, launchAuthorizationTypes, launchDomain, registryDomain, tokenMetadataHash, canonicalExemptionHash } from "@/shared/forge-typed-data";
import { startSandbox, type Sandbox } from "../helpers/sandbox";

let sb: Sandbox;
beforeAll(async () => (sb = await startSandbox()));
afterAll(async () => sb?.stop());

let seed = 0x5eed;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed);
const word = (): Hex => keccak256(toHex(rnd()));
const addr = (): Address => `0x${word().slice(26)}` as Address;
const u64 = () => BigInt(rnd()) * BigInt(rnd() % 1000);

describe("EIP-712 parity with deployed W02 contracts", () => {
  it("BindingOp digest == ForgeBindingRegistry.attestationDigestForBindingOp (25 random ops)", async () => {
    for (let i = 0; i < 25; i++) {
      const op = { githubRepoId: u64() + 1n, creator: addr(), bindingExpiresAt: u64(), opDeadline: u64(), opNonce: u64(), parentOpDigest: word(), repoFullName: `org-${rnd()}/repo-${rnd()}`, revoke: rnd() % 2 === 0 };
      const local = hashTypedData({ domain: registryDomain(31337, sb.deployment.registry), types: bindingOpTypes, primaryType: "BindingOp", message: op });
      const chain = await sb.ctx.client.readContract({ address: sb.deployment.registry, abi: forgeBindingRegistryAbi, functionName: "attestationDigestForBindingOp", args: [op] });
      expect(local).toBe(chain);
    }
  });
  it("EligibilityAttestation digest == ForgeLaunchAuthorizer.attestationDigest (25 random)", async () => {
    for (let i = 0; i < 25; i++) {
      const m = { githubRepoId: u64(), creator: addr(), bindingEpoch: u64(), issuedAt: u64(), expiresAt: u64() };
      const local = hashTypedData({ domain: launchDomain(31337, sb.deployment.authorizer), types: eligibilityAttestationTypes, primaryType: "EligibilityAttestation", message: m });
      const chain = await sb.ctx.client.readContract({ address: sb.deployment.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "attestationDigest", args: [m.githubRepoId, m.creator, m.bindingEpoch, m.issuedAt, m.expiresAt] });
      expect(local).toBe(chain);
    }
  });
  it("LaunchAuthorization digest == ForgeLaunchAuthorizer.consentDigest, and metadata hash == metadataDigest (25 random)", async () => {
    for (let i = 0; i < 25; i++) {
      const meta = { name: `N${rnd()}`, symbol: `S${rnd() % 999}`, logo: `https://x/${rnd()}`, description: "d".repeat(rnd() % 50), socials: { twitter: `t${rnd()}`, telegram: "", discord: "", website: `w${rnd()}`, farcaster: "" } };
      const intent = {
        factory: addr(), creator: addr(), githubRepoId: u64(), launchConfigId: BigInt(rnd() % 5), pairToken: addr(),
        tokenMetadataHash: tokenMetadataHash(meta), economicsDigest: word(), salt: word(), expiresAt: u64(), nonce: BigInt(rnd() % 100),
        creatorTaxBps: rnd() % 1001, exemptionListHash: canonicalExemptionHash([addr(), addr()]),
      };
      const fee = addr();
      const buyback = rnd() % 2 === 0;
      const local = hashTypedData({ domain: launchDomain(31337, sb.deployment.authorizer), types: launchAuthorizationTypes, primaryType: "LaunchAuthorization", message: launchAuthorizationMessage(intent, fee, buyback) });
      const chain = await sb.ctx.client.readContract({ address: sb.deployment.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "consentDigest", args: [intent, fee, buyback] });
      expect(local).toBe(chain);
      const md = await sb.ctx.client.readContract({ address: sb.deployment.authorizer, abi: forgeLaunchAuthorizerAbi, functionName: "metadataDigest", args: [intent.tokenMetadataHash, fee, buyback, intent.creatorTaxBps] });
      expect(launchAuthorizationMessage(intent, fee, buyback).tokenMetadataHash).toBe(md);
    }
  });
});
