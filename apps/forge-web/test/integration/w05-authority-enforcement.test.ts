/**
 * W05: every authority-matrix row that claims a privileged caller is
 * actually refused for an unprivileged caller on a deployed stack (local
 * Anvil, real Forge contracts). Calls are simulated (eth_call) with
 * zero-valued arguments, so the gate itself — not argument validation — must
 * be what rejects them: the error must be the role's own error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, createPublicClient, decodeErrorResult, encodeFunctionData, http, zeroAddress, type Abi, type AbiFunction, type AbiParameter, type Address, type Hex } from "viem";
import { formatAbiItem } from "viem/utils";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deploySandbox, type SandboxDeployment } from "../../scripts/sandbox-lib";
import { FORGE_OUT } from "../../scripts/artifacts";
import { startAnvil, type Anvil } from "../helpers/anvil";
import matrix from "../../config/authority-matrix.json";

const STRANGER = "0x00000000000000000000000000000000DeaDBeef" as Address;

/** Error each gated access class must produce for a stranger. */
const EXPECTED: Record<string, RegExp> = {
  owner: /^OwnableUnauthorizedAccount$/,
  "forge-factory": /^(NotFactory|OnlyFactory|WrongFactory|NotFactoryCaller|Unauthorized)$/,
  "pool-manager": /^(NotPoolManager|HookNotImplemented)$/,
  "treasury-recipient": /^NotTreasuryRecipient$/,
  "pending-owner": /^OwnableUnauthorizedAccount$/,
};

function zeroFor(p: AbiParameter): unknown {
  if (p.type.endsWith("]")) return [];
  if (p.type === "tuple") return Object.fromEntries(((p as { components: AbiParameter[] }).components ?? []).map((c) => [c.name, zeroFor(c)]));
  if (p.type === "address") return zeroAddress;
  if (p.type === "bool") return false;
  if (p.type === "string") return "";
  if (p.type === "bytes") return "0x";
  if (p.type.startsWith("bytes")) return `0x${"00".repeat(Number(p.type.slice(5)))}`;
  return 0n;
}

let anvil: Anvil;
let d: SandboxDeployment;

beforeAll(async () => {
  anvil = await startAnvil();
  d = await deploySandbox(anvil.url);
}, 180_000);
afterAll(async () => anvil?.stop());

describe("W05: authority-matrix claims hold on a deployed stack", () => {
  it("every privileged row is refused for a stranger with the role's own error", async () => {
    const pub = createPublicClient({ transport: http(anvil.url) });
    const address: Record<string, Address> = {
      PonsV2LaunchFactory: d.factory,
      ForgeLaunchAuthorizer: d.authorizer,
      ForgeBindingRegistry: d.registry,
      PonsV2MemeHook: d.memeHook,
      PonsV2FeeEscrow: d.feeEscrow,
      ForgeProtocolRevenueSplitter: d.revenueSplitter,
      PonsV2BuybackVault: d.buybackVault,
      PonsV2LaunchLocker: d.locker,
      PonsV2GraduationExecutor: d.graduationExecutor,
      PonsV2LaunchDeployer: d.launchDeployer,
    };
    const checked: string[] = [];
    const failures: string[] = [];
    for (const [name, entry] of Object.entries(matrix.contracts)) {
      const abi = JSON.parse(readFileSync(path.join(FORGE_OUT, `${name}.sol`, `${name}.json`), "utf8")).abi as Abi;
      for (const row of entry.functions) {
        const want = EXPECTED[row.access];
        if (!want) continue;
        const fn = (abi as AbiFunction[]).find((f) => f.type === "function" && formatAbiItem(f) === row.signature)!;
        const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: fn.inputs.map(zeroFor) } as never) as Hex;
        try {
          await pub.call({ account: STRANGER, to: address[name]!, data });
          failures.push(`${name}.${row.signature}: SUCCEEDED for a stranger`);
        } catch (e) {
          const hit = e instanceof BaseError ? e.walk((x) => typeof (x as { data?: unknown }).data === "string") : null;
          const raw = (hit as { data?: Hex } | null)?.data;
          let errName = "UNDECODED";
          try {
            errName = decodeErrorResult({ abi, data: raw! }).errorName;
          } catch {
            errName = `UNDECODED(${String(raw).slice(0, 10)})`;
          }
          if (!want.test(errName)) failures.push(`${name}.${row.signature}: reverted with ${errName}, expected ${want}`);
          checked.push(`${name}.${row.signature.split("(")[0]}=${errName}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked.length).toBeGreaterThanOrEqual(60);
  });
});
