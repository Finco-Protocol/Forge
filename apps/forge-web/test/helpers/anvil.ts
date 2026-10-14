import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

export interface Anvil {
  url: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Local chain for acceptance: a STANDARD Anvil with the EIP-170 code-size
 * limit enforced (W03 Correction A resolved W02-SIZE-01; the sandbox never
 * disables the limit).
 */
export async function startAnvil(port?: number): Promise<Anvil> {
  const p = port ?? (await freePort());
  const proc = spawn("anvil", ["--port", String(p), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port: p,
    proc,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
