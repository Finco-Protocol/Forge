/** Local Anvil process management for the W05 harnesses (scripts + tests). */
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

export interface AnvilProc {
  url: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function rpcCall<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Spawns a STANDARD Anvil (EIP-170 enforced) on 127.0.0.1. `extra` may add
 * `--fork-url …` etc. Waits until eth_chainId answers (forks can be slow).
 */
export async function spawnAnvil(extra: string[] = [], opts: { timeoutMs?: number } = {}): Promise<AnvilProc> {
  const port = await freePort();
  let stderr = "";
  const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--silent", ...extra], { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited (${proc.exitCode}): ${stderr.slice(0, 2000)}`);
    try {
      await rpcCall(url, "eth_chainId");
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        throw new Error(`anvil did not come up within ${opts.timeoutMs ?? 60_000} ms: ${stderr.slice(0, 2000)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return {
    url,
    port,
    proc,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
