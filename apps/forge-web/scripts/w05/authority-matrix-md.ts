/** Renders config/authority-matrix.json → docs/W05-AUTHORITY-MATRIX.md (deterministic; drift-tested). */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
type Fn = { signature: string; access: string; category: string; timelock: string; emergency: boolean; monitoringEvents: string[]; note: string };
type Matrix = { contracts: Record<string, { ownership: string; upgradeable: boolean; functions: Fn[] }> };

export function renderAuthorityMatrix(m: Matrix): string {
  const out: string[] = [];
  out.push("# W05 — Contract Authority Matrix", "");
  out.push(
    "_Generated from `apps/forge-web/config/authority-matrix.json` by `scripts/w05/authority-matrix-md.ts`; do not edit by hand. The JSON is drift-tested against the compiled ABIs (every state-changing function must be classified) and every privileged row is proven refused for a stranger on a deployed stack (`test/unit/w05-authority-matrix.test.ts`, `test/integration/w05-authority-enforcement.test.ts`)._",
    "",
  );
  out.push("## Scope and identity", "");
  out.push(
    "- **Contract / source identity:** the Forge-owned stack compiled by `forge build --profile forge` (solc 0.8.35, optimizer 200, via_ir, cancun). Source parity with the deploy-time PONS tree is proven by `provenance/verify-parity.sh`; addresses exist only in sandboxes. No Forge contract is deployed on Robinhood Chain 4663.",
    "- **Owner / pending owner:** every `Ownable2Step` contract is owned by one account chosen at deployment. Sandbox: a single Anvil key. Production target: a Safe (>=3 owners, strict-majority threshold) behind a self-administered timelock (>=2 days) — **operator evidence required (release item B03)**; nothing has been transferred.",
    "- **Upgradeability:** none. No proxy, no `delegatecall`, no `selfdestruct` in any listed contract; behaviour changes require a new deployment and a new factory/hook wiring.",
    "- **Custody exposure:** `PonsV2FeeEscrow` holds all claimable creator/protocol fees; the splitter holds treasury and reserve liabilities and non-revenue; the factory holds swept graduation reserves until seeding or rescue; the buyback vault holds locked project tokens; the locker holds the permanently locked LP position.",
    "- **Timelocks that exist on chain:** creator-fee-recipient override (3 d notice + 3 d window), treasury recipient and revenue attestor changes (3 d + 3 d), graduation rescue (7 d after sweep), signed registry operations (<=10 min). Every other owner function is **immediate**; under a timelock owner it inherits the owner's delay (finding W05-03).",
    "",
  );
  for (const [name, c] of Object.entries(m.contracts)) {
    out.push(`## ${name}`, "", `Ownership: ${c.ownership} · Upgradeable: ${c.upgradeable ? "yes" : "no"}`, "");
    out.push("| Function | Caller | Category | Timelock | Emergency | Monitoring events | Note |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const f of c.functions) {
      const sig = f.signature.length > 70 ? `${f.signature.slice(0, 67)}…` : f.signature;
      out.push(`| \`${sig}\` | ${f.access} | ${f.category} | ${f.timelock} | ${f.emergency ? "**yes**" : ""} | ${f.monitoringEvents.map((e) => `\`${e}\``).join(", ")} | ${f.note} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = JSON.parse(readFileSync(path.join(ROOT, "apps/forge-web/config/authority-matrix.json"), "utf8")) as Matrix;
  writeFileSync(path.join(ROOT, "docs/W05-AUTHORITY-MATRIX.md"), renderAuthorityMatrix(m) + "\n");
  console.log("wrote docs/W05-AUTHORITY-MATRIX.md");
}
