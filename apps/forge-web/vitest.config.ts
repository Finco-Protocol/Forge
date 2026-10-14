import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = { "@": path.resolve(__dirname, "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
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
    ],
  },
});
