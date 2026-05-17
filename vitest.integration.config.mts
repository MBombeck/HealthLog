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
    // v1.4.37 W-CI — switched from `isolate: false` to `isolate: true`.
    // The previous setting reused the module graph across files inside
    // one fork; mock declarations (`vi.mock("@/lib/notifications/...")`,
    // `vi.mock("@parse/node-apn")`) registered in `apns-dispatch.test.ts`
    // and `integration-status.test.ts` lost to whichever earlier file
    // had already pulled the real dispatcher / sender modules into the
    // shared graph, so the in-suite run showed flaky 0-call mocks while
    // each file passed in isolation. Re-isolating module state per file
    // costs ~10 s of import-rebuild on a 56-file run; the Postgres
    // testcontainer + migrations still live in `globalSetup` so the
    // expensive boot cost is unaffected.
    isolate: true,
    // One container for the whole run; tests truncate between them.
    globalSetup: ["./tests/integration/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
