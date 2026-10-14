/**
 * W05 fork mode (CI only): the SAME genuine-V4 lifecycle as test/v4, on a
 * LOCAL Anvil fork of Robinhood Chain 4663 using the REAL deployed
 * PoolManager / PositionManager / Permit2 (config/networks/robinhood-4663.json).
 * Fails loudly without FORGE_FORK_RPC_URL. Every transaction goes to the local
 * fork; nothing is ever broadcast to chain 4663.
 */
import { defineGenuineLifecycleSuite } from "../v4/lifecycle-suite";

defineGenuineLifecycleSuite("fork");
