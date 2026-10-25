import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { createDurationSequencer } from "./tests/durations/sequencer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function integrationWorkers(): number {
  const pinned = Number.parseInt(
    process.env.HEALTHLOG_INTEGRATION_WORKERS ?? "",
    10,
  );
  if (Number.isInteger(pinned) && pinned > 0) return pinned;
  // Half the cores: the other half runs Postgres and the container runtime.
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
}

// Integration suite — boots a real Postgres in a testcontainer and runs
// migrations against it. Slow (container boot ~5–15s on a cold pull),
// so excluded from the default `pnpm test` and triggered explicitly via
// `pnpm test:integration`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Same host-timezone pin as the unit config — CI runs UTC, so the
    // integration contracts must be read against the same clock.
    env: {
      TZ: "UTC",
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      ENCRYPTION_KEYS: "",
      ENCRYPTION_ACTIVE_KEY_ID: "",
      API_TOKEN_HMAC_KEY:
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      SESSION_SECRET: "integration-test-session-secret-32-bytes",
      // Deletions erase at once here, the behaviour the suite was written
      // against; the grace window (14 days in production) is pinned by the
      // files that set it themselves (`account-deletion-grace.test.ts`,
      // `offhost-purge-on-deletion.test.ts`).
      ACCOUNT_DELETION_GRACE_DAYS: "0",
    },
    include: ["tests/integration/**/*.test.ts"],
    // Container boot + migration apply is slow; give each test a generous
    // budget and beforeAll/afterAll twice that.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Files run in parallel, one database per worker: global setup migrates a
    // template once and each worker clones it on its first file (see
    // `tests/integration/worker-database.ts`). The worker count follows the
    // host unless `HEALTHLOG_INTEGRATION_WORKERS` pins it; CI pins it to what
    // a runner shared with the Postgres container can carry.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: integrationWorkers(),
    // `--shard` deals files out by measured duration (CI runs four shards), and
    // files start longest first so a parallel run does not end on one slow
    // file. Order dependence is surfaced on purpose by the nightly shuffled
    // run (`.github/workflows/test-nightly.yml`), which passes
    // `--sequence.shuffle` and prints the seed it used.
    sequence: {
      sequencer: createDurationSequencer(
        "tests/durations/integration.json",
        0.6,
      ),
    },
    // v1.4.37 — switched from `isolate: false` to `isolate: true`.
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
    // Point each isolated worker at its own clone before application modules
    // read DATABASE_URL at import time.
    setupFiles: ["./tests/integration/environment-setup.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
