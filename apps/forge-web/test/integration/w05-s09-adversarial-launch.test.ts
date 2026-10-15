/**
 * S09 adversarial launch scenarios on the REAL Forge contracts (local Anvil only, eth_call simulations, no real chain).
 *
 * The deploy smoke test S09 accepts only the exact ECDSAInvalidSignatureLength(0) of an empty signature. These
 * scenarios go further: every signature is STRUCTURALLY VALID (65-byte, correctly recovered EIP-712 consent from the
 * creator and a genuine attestation from the eligibility authority), yet the launch is refused by the Forge launch
 * authorization authority (ForgeLaunchAuthorizer / ForgeBindingRegistry) for a binding or domain reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { reviveTypedData } from "@/shared/launch-tx";
import { eligibilityAttestationTypes, encodeAttestationPayload } from "@/shared/forge-typed-data";
import { readRegistryState } from "@/server/chain/forge";
import { revokeOnChain } from "@/server/eligibility/registry-ops";
import { SANDBOX_ROLES } from "../../scripts/sandbox-lib";
import { startSandbox, type Sandbox } from "../helpers/sandbox";
import { freshScenario, freshCreator, signedLaunch, simulateLaunch } from "../helpers/scenario";

let sb: Sandbox;
beforeAll(async () => {
  sb = await startSandbox();
});
afterAll(async () => sb?.stop());

/**
 * An attestation signed DIRECTLY with the eligibility-authority key - what a leaked key or a mis-issuing authority would
 * produce (the guarded signer service itself refuses to sign without a verified GitHub verification). Bound to the
 * registry's current epoch, so only the registry binding can still stop it.
 */
async function attest(repoId: bigint, creator: Address, domain: ReturnType<typeof reviveTypedData>["domain"]) {
  const state = await readRegistryState(sb.ctx.client, sb.ctx.cfg.addresses, repoId);
  const issuedAt = state.blockTimestamp;
  const expiresAt = issuedAt + 3600n;
  const signature = await privateKeyToAccount(SANDBOX_ROLES.authority).signTypedData({
    domain,
    types: eligibilityAttestationTypes,
    primaryType: "EligibilityAttestation",
    message: { githubRepoId: repoId, creator, bindingEpoch: state.bindingEpoch, issuedAt, expiresAt },
  });
  return encodeAttestationPayload(issuedAt, expiresAt, signature);
}

/** A consent for `message` overrides, signed by `key`, merged into an otherwise valid launch call. */
async function forge(base: Awaited<ReturnType<typeof signedLaunch>>, key: Hex, over: { githubRepoId?: bigint; creator?: Address; domainVerifier?: Address }, attestationPayload: Hex) {
  const td = reviveTypedData(base.auth.json.typedData);
  const message = { ...td.message, ...(over.githubRepoId !== undefined ? { githubRepoId: over.githubRepoId } : {}), ...(over.creator ? { creator: over.creator } : {}) };
  const domain = over.domainVerifier ? { ...td.domain, verifyingContract: over.domainVerifier } : td.domain;
  const creatorSignature = await privateKeyToAccount(key).signTypedData({ ...td, domain, message });
  return { ...base.call, params: { ...base.call.params, ...(over.githubRepoId !== undefined ? { githubRepoId: over.githubRepoId } : {}), creatorSignature, attestationPayload } };
}

describe("S09 adversarial: valid signatures, invalid eligibility/binding -> refused by the Forge authority", () => {
  it("control: the untampered launch simulates OK", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("OK");
  });

  it("wrong repository ID: valid consent + valid authority attestation for a repo the creator does not hold -> BindingNotActive", async () => {
    const owner = await freshScenario(sb); // holds the active binding for its own repo
    const thief = await freshScenario(sb);
    const base = await signedLaunch(sb, thief.browser, thief.key, thief.draft);
    const victimRepo = BigInt(owner.repoId);
    const call = await forge(base, thief.key, { githubRepoId: victimRepo }, await attest(victimRepo, thief.address, reviveTypedData(base.auth.json.typedData).domain));
    const out = await simulateLaunch(sb, thief.key, call);
    expect(out).toBe("BindingNotActive");
    expect(out).not.toBe("InvalidCreatorSignature"); // the signature layer passed
  });

  it("wrong wallet: another wallet with a genuine consent+attestation for someone else's active repo -> BindingNotActive", async () => {
    const s = await freshScenario(sb);
    const base = await signedLaunch(sb, s.browser, s.key, s.draft);
    const attackerKey = await freshCreator(sb);
    const attacker = privateKeyToAccount(attackerKey).address;
    const forged = await forge(base, attackerKey, { creator: attacker }, await attest(BigInt(s.repoId), attacker, reviveTypedData(base.auth.json.typedData).domain));
    // keep the effective fee recipient identical to the one hashed into the consent (the factory defaults it to msg.sender)
    const call = { ...forged, params: { ...forged.params, creatorFeeRecipient: base.call.params.creatorFeeRecipient === "0x0000000000000000000000000000000000000000" ? s.address : base.call.params.creatorFeeRecipient } };
    expect(await simulateLaunch(sb, attackerKey, call)).toBe("BindingNotActive");
    // and the real owner's own call is unaffected
    expect(await simulateLaunch(sb, s.key, base.call)).toBe("OK");
  });

  it("revoked eligibility: unexpired valid consent + attestation after on-chain revocation -> refused (BindingNotActive or InvalidAttestationSignature), never OK", async () => {
    const s = await freshScenario(sb);
    const l = await signedLaunch(sb, s.browser, s.key, s.draft);
    expect(await simulateLaunch(sb, s.key, l.call)).toBe("OK");
    await revokeOnChain(sb.ctx, BigInt(s.repoId), "s09_revoked");
    const out = await simulateLaunch(sb, s.key, l.call);
    expect(["BindingNotActive", "InvalidAttestationSignature"]).toContain(out);
  });

  it("wrong authorization domain: consent signed for another verifyingContract recovers a different signer -> WrongCreator", async () => {
    const s = await freshScenario(sb);
    const base = await signedLaunch(sb, s.browser, s.key, s.draft);
    const call = await forge(base, s.key, { domainVerifier: sb.deployment.registry }, base.call.params.attestationPayload as Hex);
    expect(await simulateLaunch(sb, s.key, call)).toBe("WrongCreator");
  });

  it("attestation signed by the CREATOR instead of the authority (not independent) -> SignaturesNotIndependent", async () => {
    const s = await freshScenario(sb);
    const base = await signedLaunch(sb, s.browser, s.key, s.draft);
    const state = await readRegistryState(sb.ctx.client, sb.ctx.cfg.addresses, BigInt(s.repoId));
    const issuedAt = state.blockTimestamp;
    const expiresAt = issuedAt + 3600n;
    const sig = await privateKeyToAccount(s.key).signTypedData({
      domain: reviveTypedData(base.auth.json.typedData).domain,
      types: eligibilityAttestationTypes,
      primaryType: "EligibilityAttestation",
      message: { githubRepoId: BigInt(s.repoId), creator: s.address, bindingEpoch: state.bindingEpoch, issuedAt, expiresAt },
    });
    const call = { ...base.call, params: { ...base.call.params, attestationPayload: encodeAttestationPayload(issuedAt, expiresAt, sig) } };
    expect(await simulateLaunch(sb, s.key, call)).toBe("SignaturesNotIndependent");
  });
});
