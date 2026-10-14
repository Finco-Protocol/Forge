/**
 * Live safety flags as compiled into this build, read by the release gate.
 * Each value is imported from the module that enforces it, so the gate
 * checks the real constant, not a copy.
 */
import { FORGE_FEE_POLICY_AUTHORITY_UNPROVEN, PRODUCTION_BLOCKED, REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED } from "../server/config";
import { FINCO_BURN_ENABLED } from "../server/finance/service";

export function currentFlags(): Record<string, boolean> {
  return {
    PRODUCTION_BLOCKED,
    FINCO_BURN_ENABLED,
    FORGE_FEE_POLICY_AUTHORITY_UNPROVEN,
    REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED,
  };
}
