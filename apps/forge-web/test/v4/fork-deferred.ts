/**
 * Genuine-V4 lifecycle steps that are SKIPPED in Anvil-fork mode (the fork emulates ArbOS; see
 * docs/W05-ROBINHOOD-V4-DEPLOYMENT.md). Single source of truth shared by the suite and the release-gate
 * drift test: release/readiness-items.json A07e must list exactly these steps as NOT VERIFIED.
 */
export const FORK_DEFERRED_STEPS = [7, 8, 9] as const;
