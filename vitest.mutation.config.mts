import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stryker's Vitest runner runs the tests in worker threads, and a thread
// takes the process's zone, not `test.env.TZ`. Set on the process that loads
// this config, before any worker starts, so a run on a machine outside UTC
// sees the same suite as CI instead of failing its dry run on a wall-clock
// test.
process.env.TZ = "UTC";

/**
 * The unit tests Stryker runs against each mutant (see `stryker.config.mjs`):
 * the tests that live next to the mutated modules, property tests included.
 * Kept narrow on purpose, because Stryker runs this set once to map coverage
 * and then the covering tests once per mutant. Same environment as the unit
 * suite (`vitest.config.mts`): UTC host zone, the same setup file.
 *
 * "Next to" is checked, not trusted: every test in the `__tests__` folder of
 * a mutated file's directory that imports that file has to be matched here
 * (`src/__tests__/mutation-instrument-guard.test.ts`). The backup slices
 * are the case that made it a rule: they were mutated while the tests in
 * `src/lib/export/__tests__/` never ran, so eleven slices scored 0 %.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: { TZ: "UTC" },
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "src/lib/__tests__/crypto*.test.ts",
      "src/lib/analytics/compliance/__tests__/**/*.test.ts",
      "src/lib/rollups/__tests__/**/*.test.ts",
      "src/lib/analytics/__tests__/source-*.test.ts",
      "src/lib/measurements/__tests__/display-transform*.test.ts",
      "src/lib/measurements/__tests__/indoor-climate.test.ts",
      "src/lib/measurements/__tests__/unit-label.test.ts",
      "src/lib/measurements/__tests__/units.property.test.ts",
      "src/lib/__tests__/glucose*.test.ts",
      "src/lib/validations/__tests__/backup*.test.ts",
      "src/lib/export/__tests__/**/*.test.ts",
      "src/lib/cycle/__tests__/backup*.test.ts",
      "src/__tests__/app-settings-backup-classification.test.ts",
      "src/lib/medications/scheduling/__tests__/**/*.test.ts",
      "src/lib/auth/__tests__/hmac.test.ts",
      "src/lib/auth/__tests__/oidc-native-handoff.test.ts",
      "src/lib/auth/__tests__/step-up.test.ts",
      "src/lib/validations/__tests__/notifications.test.ts",
      "src/lib/__tests__/safe-fetch*.test.ts",
      "src/lib/push-relay/__tests__/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
