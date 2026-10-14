import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = { "@": path.resolve(__dirname, "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node", testTimeout: 30_000 } },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 180_000,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      { resolve: { alias }, test: { name: "fork", include: ["test/fork/**/*.test.ts"], environment: "node", testTimeout: 60_000 } },
      // W05: genuine Uniswap V4 (local Anvil + pinned genuine artifacts; requires `forge build --profile forge`).
      {
        resolve: { alias },
        test: { name: "v4", include: ["test/v4/**/*.test.ts"], environment: "node", testTimeout: 120_000, hookTimeout: 300_000, pool: "forks", poolOptions: { forks: { singleFork: true } } },
      },
      // W05: the same lifecycle on a LOCAL Anvil fork of Robinhood Chain 4663 (CI only; FORGE_FORK_RPC_URL required).
      {
        resolve: { alias },
        test: { name: "v4-fork", include: ["test/v4-fork/**/*.test.ts"], environment: "node", testTimeout: 300_000, hookTimeout: 600_000, pool: "forks", poolOptions: { forks: { singleFork: true } } },
      },
      // W05: real PostgreSQL (opt-in via FORGE_TEST_DATABASE_URL; FORGE_TEST_REQUIRE_PG=1 makes it mandatory). See test/helpers/pg.ts.
      {
        resolve: { alias },
        test: {
          name: "pg",
          include: ["test/pg/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 240_000,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
