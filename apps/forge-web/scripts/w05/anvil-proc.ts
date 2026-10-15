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
  /** tail of anvil's stdout+stderr (only populated when spawned with captureLogs) */
  logs(): string;
  /** SIGTERM, wait for exit, SIGKILL after 5 s; resolves once the process is gone */
  stop(): Promise<void>;
}

const LOG_CAP = 64 * 1024;

/** Every request is bounded (default 120 s, or the caller's signal): a node that accepts the connection but never answers cannot hang the harness. */
export async function rpcCall<T = unknown>(url: string, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: signal ?? AbortSignal.timeout(120_000) });
  const j = (await r.json()) as { result: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Spawns a STANDARD Anvil (EIP-170 enforced) on 127.0.0.1. `extra` may add
 * `--fork-url …` etc. Waits until eth_chainId answers (forks can be slow).
 */
export async function spawnAnvil(extra: string[] = [], opts: { timeoutMs?: number; captureLogs?: boolean } = {}): Promise<AnvilProc> {
  const port = await freePort();
  let stderr = "";
  let tail = "";
  const append = (d: Buffer) => {
    tail += d.toString();
    if (tail.length > LOG_CAP) tail = tail.slice(-LOG_CAP);
  };
  // captureLogs: no --silent so the node's own request/mining/fork-backend log lines are available as failure evidence.
  const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), ...(opts.captureLogs ? [] : ["--silent"]), ...extra], { stdio: ["ignore", opts.captureLogs ? "pipe" : "ignore", "pipe"] });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > LOG_CAP) stderr = stderr.slice(-LOG_CAP);
    append(d);
  });
  proc.stdout?.on("data", append);
  // never leave an orphan if the harness process itself exits
  const reap = () => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  };
  process.once("exit", reap);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`anvil exited (${proc.exitCode}): ${stderr.slice(0, 2000)}`);
    // the readiness probe is bounded by the remaining startup budget (min 1 s) so an unresponsive node cannot outlive timeoutMs
    const probe = AbortSignal.timeout(Math.max(1_000, deadline - Date.now()));
    try {
      await rpcCall(url, "eth_chainId", [], probe);
      break;
    } catch {
      if (Date.now() >= deadline) {
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
    logs: () => tail,
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
        proc.kill("SIGTERM");
        const killer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(killer);
      }
      process.removeListener("exit", reap);
    },
  };
}
