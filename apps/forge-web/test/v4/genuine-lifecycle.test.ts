/**
 * W05 local-genuine acceptance: fresh Anvil + GENUINE Uniswap V4 artifacts
 * (no mini mocks) + the real Forge stack. See docs/W05-ROBINHOOD-V4-DEPLOYMENT.md.
 */
import { defineGenuineLifecycleSuite } from "./lifecycle-suite";

defineGenuineLifecycleSuite("local-genuine");
