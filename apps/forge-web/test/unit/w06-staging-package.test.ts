/**
 * Static verification of the staging package. docker compose is NOT executed here (no Docker daemon in the
 * development sandbox; the CI `staging-compose` job runs it where Docker exists). These checks parse the files
 * and assert the safety properties the README claims.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { stagingViolations } from "@/server/staging/guard";
import { buildManifest, verifyManifest } from "../../scripts/w06/staging-lib";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const compose = parse(read("ops/staging/docker-compose.staging.yml"), { merge: true }) as {
  services: Record<string, { networks?: string[]; ports?: string[]; image?: string; environment?: Record<string, string>; depends_on?: Record<string, { condition: string }>; cap_drop?: string[]; security_opt?: string[] }>;
  networks: Record<string, { internal?: boolean }>;
  "x-forge-env": Record<string, string>;
};

describe("W06 staging package (static)", () => {
  it("the backend network is internal (no route to the Internet)", () => {
    expect(compose.networks.backend!.internal).toBe(true);
    expect(compose.networks.edge!.internal).not.toBe(true);
  });

  it("only web and the simulated GitHub join the edge network and publish ports, bound to loopback", () => {
    const edge = Object.entries(compose.services).filter(([, s]) => s.networks?.includes("edge")).map(([n]) => n).sort();
    expect(edge).toEqual(["fake-github", "web"]);
    for (const [name, s] of Object.entries(compose.services)) {
      for (const p of s.ports ?? []) expect(p, `${name} port`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
      if (!(s.ports ?? []).length) expect(s.networks, name).toEqual(["backend"]);
    }
  });

  it("every Forge process runs the same hardened image, drops capabilities and validates the environment", () => {
    for (const n of ["fake-github", "deploy", "migrate", "web", "worker"]) {
      expect(compose.services[n]!.image).toBe("forge-staging:local");
      expect(compose.services[n]!.cap_drop).toEqual(["ALL"]);
      expect(compose.services[n]!.security_opt).toContain("no-new-privileges:true");
    }
    expect(read("ops/staging/entrypoint.sh")).toContain("staging:check");
  });

  it("migrations run once, before web and worker, which only VERIFY the schema", () => {
    expect(compose.services.web!.depends_on!.migrate!.condition).toBe("service_completed_successfully");
    expect(compose.services.worker!.depends_on!.migrate!.condition).toBe("service_completed_successfully");
    expect(compose.services.web!.environment!.FORGE_DB_MIGRATE).toBe("verify");
    expect(compose.services.worker!.environment!.FORGE_DB_MIGRATE).toBe("verify");
    expect(compose.services.migrate!.environment!.FORGE_DB_MIGRATE).toBe("apply");
  });

  it("the shared environment is accepted by the staging guard and carries every frozen flag", () => {
    const env = compose["x-forge-env"];
    expect(env.FORGE_STAGING).toBe("true");
    expect(env.FINCO_BURN_ENABLED).toBe("false");
    expect(env.PRODUCTION_SIGNING_ENABLED).toBe("false");
    expect(env.REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED).toBe("false");
    expect(env.DEPLOY_WRITE_ENABLED).toBe("false");
    expect(env.PRODUCTION_BLOCKED).toBe("true");
    // substitute the ${VAR} placeholders with the example file's values (+ a real-looking secret for the sample ones)
    const example = Object.fromEntries(read("ops/staging/.env.staging.example").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const sub = (v: string) => v.replace(/\$\{([A-Z_]+)[^}]*\}/g, (_m, k: string) => example[k] ?? "");
    const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, sub(String(v))]));
    // the entrypoint exports these from the staging overrides after sourcing the simulated-GitHub credentials
    resolved.GITHUB_API_URL = resolved.STAGING_GITHUB_API_URL!;
    resolved.GITHUB_WEB_URL = resolved.STAGING_GITHUB_WEB_URL!;
    resolved.SESSION_SECRET = "f".repeat(64);
    resolved.FORGE_OPS_TOKEN = "e".repeat(48);
    expect(stagingViolations(resolved)).toEqual([]);
  });

  it("the shipped example secrets are placeholders the guard REFUSES until replaced", () => {
    const example = Object.fromEntries(read("ops/staging/.env.staging.example").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const v = stagingViolations({ FORGE_STAGING: "true", DATABASE_URL: "postgres://u:p@127.0.0.1/forge_staging", SESSION_SECRET: example.SESSION_SECRET, FORGE_OPS_TOKEN: example.FORGE_OPS_TOKEN });
    expect(v.filter((x) => x.code === "STAGING_SECRET").length).toBe(2);
  });

  it("contains no production credentials: only well-known Anvil keys, no cloud hosts", () => {
    const text = read("ops/staging/.env.staging.example") + read("ops/staging/docker-compose.staging.yml");
    expect(text).not.toMatch(/amazonaws|googleapis|azure|alchemy|infura|robinhood\.com|api\.github\.com/i);
    const keys = text.match(/0x[0-9a-f]{64}/g) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    expect(stagingViolations({ FORGE_STAGING: "true", ...Object.fromEntries(keys.map((k, i) => [["FORGE_AUTHORITY_PRIVATE_KEY", "FORGE_EVIDENCE_PRIVATE_KEY", "FORGE_RELAYER_PRIVATE_KEY", "FORGE_REVENUE_ATTESTOR_PRIVATE_KEY"][i % 4]!, k])) }).filter((x) => x.code === "STAGING_KEY_NOT_TEST_ONLY")).toEqual([]);
  });

  it("the Dockerfile pins its toolchain and does not run as root", () => {
    const d = read("ops/staging/Dockerfile");
    expect(d).toContain("ghcr.io/foundry-rs/foundry:v1.8.5");
    expect(d).toContain("pnpm@10.28.0");
    expect(d).toContain("--frozen-lockfile");
    expect(d).toMatch(/^USER forge$/m);
  });
});

describe("W06 build manifest", () => {
  it("is deterministic for the same inputs and verifies", () => {
    const a = buildManifest({ gitSha: "a".repeat(40) });
    const b = buildManifest({ gitSha: "a".repeat(40) });
    expect(a.digest).toBe(b.digest);
    expect(verifyManifest(a)).toEqual([]);
    expect(a.migrations.length).toBeGreaterThanOrEqual(6);
    expect(a.flags).toEqual({ PRODUCTION_BLOCKED: true, FINCO_BURN_ENABLED: false, FORGE_FEE_POLICY_AUTHORITY_UNPROVEN: true, PRODUCTION_SIGNING_ENABLED: false, REVENUE_ATTESTATION_PRODUCTION_SIGNING_ENABLED: false, DEPLOY_WRITE_ENABLED: false });
  });

  it("detects tampering, flag drift and migration drift", () => {
    const m = buildManifest({ gitSha: "b".repeat(40) });
    expect(verifyManifest({ ...m, git: { ...m.git, sha: "c".repeat(40) } })).toEqual(expect.arrayContaining([expect.stringContaining("MANIFEST_DIGEST_MISMATCH")]));
    const drifted = { ...m, flags: { ...m.flags, PRODUCTION_BLOCKED: false as unknown as true } };
    expect(verifyManifest(drifted).join()).toContain("MANIFEST_FLAG_DRIFT");
    const mig = { ...m, migrations: m.migrations.slice(1) };
    expect(verifyManifest(mig).join()).toContain("MANIFEST_MIGRATIONS_DRIFT");
  });
});
