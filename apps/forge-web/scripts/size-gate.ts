/**
 * Mandatory EIP-170 gate for the Forge-owned stack. Fails (exit 1) if any
 * deployable runtime exceeds 24,576 bytes, or if the factory's headroom drops
 * below FORGE_FACTORY_MIN_MARGIN (default 64 bytes) — the margin is reported
 * so regressions are visible before they become blockers.
 */
import { EIP170_LIMIT, eip170Report } from "./sandbox-lib";

const minMargin = Number(process.env.FORGE_FACTORY_MIN_MARGIN ?? 64);
const report = eip170Report();
console.table(report.map((r) => ({ ...r, margin: EIP170_LIMIT - r.runtimeBytes })));
const over = report.filter((r) => r.exceeds);
const factory = report.find((r) => r.contract === "PonsV2LaunchFactory")!;
if (over.length) {
  console.error(`EIP-170 GATE FAILED: ${over.map((r) => `${r.contract}=${r.runtimeBytes}`).join(", ")} > ${EIP170_LIMIT}`);
  process.exit(1);
}
if (EIP170_LIMIT - factory.runtimeBytes < minMargin) {
  console.error(`EIP-170 GATE FAILED: factory margin ${EIP170_LIMIT - factory.runtimeBytes} B < required ${minMargin} B`);
  process.exit(1);
}
console.log(`EIP170_GATE_OK factory=${factory.runtimeBytes} B margin=${EIP170_LIMIT - factory.runtimeBytes} B`);
