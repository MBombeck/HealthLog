import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Integration suite — boots a real Postgres in a testcontainer and runs
// migrations against it. Slow (container boot ~5–15s on a cold pull),
// so excluded from the default `pnpm test` and triggered explicitly via
// `pnpm test:integration`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Container boot + migration apply is slow; give each test a generous
    // budget and beforeAll/afterAll twice that.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Run sequentially in a single fork so files reuse one container and
    // amortise the migration-apply cost. Vitest 4 moved these to the top
    // level (the old `poolOptions.forks.singleFork` was removed).
    pool: "forks",
    fileParallelism: false,
    isolate: false,
    // One container for the whole run; tests truncate between them.
    globalSetup: ["./tests/integration/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
