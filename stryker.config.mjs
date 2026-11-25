/**
 * Mutation testing for the core libraries: the modules where a wrong answer
 * is silent and costly (encryption at rest, medication compliance and dose
 * scheduling, rollups, source ranking, unit conversion, backup validation,
 * the token and handoff primitives, outbound egress, the push relay's wire
 * format).
 *
 * Not on pull requests: the full run takes the better part of an hour. It
 * runs nightly and on demand (`.github/workflows/mutation.yml`), and locally
 * with `pnpm exec stryker run`. The score of each module is checked against
 * the floor in `stryker.floors.json` by `node scripts/mutation-floors.mjs`,
 * so a floor is per module rather than one number for the whole run.
 *
 * The tests that run are the unit tests next to these modules (see
 * `vitest.mutation.config.mts`), not the whole suite: a mutant that only a
 * route test or an integration test would catch counts as surviving here,
 * so a score is a lower bound on what the full suite catches.
 *
 * Two rules keep the instrument pointed at what it claims to measure, and
 * `src/__tests__/mutation-instrument-guard.test.ts` holds both: every file
 * mutated here belongs to a module in `stryker.floors.json` (a file outside
 * every module would be mutated and never judged), and every unit test that
 * sits in the `__tests__` folder next to a mutated file and imports it is in
 * the mutation test set (a test that is left out makes its module look
 * untested). `scripts/mutation-floors.mjs` refuses a report that names a
 * mutated file no module claims.
 *
 * Vitest 5 names a test "describe > test" where @stryker-mutator/vitest-runner
 * 10.0.0 still built "describe test", so every test inside a describe block
 * was filtered out of the mutant runs and nearly every mutant survived.
 * `patches/@stryker-mutator__vitest-runner@10.0.0.patch` builds the name the
 * Vitest 5 way; drop it once a runner release does the same.
 */
const config = {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.mts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: [
    "src/lib/crypto.ts",
    "src/lib/analytics/compliance/*.ts",
    "src/lib/rollups/measurement-rollups.ts",
    "src/lib/rollups/tiered-context.ts",
    "src/lib/analytics/source-priority.ts",
    "src/lib/analytics/source-rank-sql.ts",
    "src/lib/measurements/display-transform.ts",
    "src/lib/glucose.ts",
    "src/lib/validations/backup.ts",
    // The payload schema's slices, one per backup domain.
    "src/lib/export/*-backup-schema.ts",
    "src/lib/export/backup-schema-kit.ts",
    "src/lib/cycle/backup-schema.ts",
    // Dose scheduling: slots, eras, recurrence, next-due. The most fixed
    // code per line in the tree.
    "src/lib/medications/scheduling/*.ts",
    // Bearer-token hashing and the native sign-in handoff.
    "src/lib/auth/hmac.ts",
    "src/lib/auth/oidc-native-handoff.ts",
    // Outbound egress: the public-address check and the fetch wrapper.
    "src/lib/validations/notifications.ts",
    "src/lib/safe-fetch.ts",
    // What the push relay puts on the wire: encoding, envelope, HPKE.
    "src/lib/push-relay/encoding.ts",
    "src/lib/push-relay/envelope.ts",
    "src/lib/push-relay/hpke.ts",
  ],
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // The per-module floors live in stryker.floors.json; the run itself never
  // fails on a score, only on an error.
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 20_000,
  // The initial run maps coverage for every test in one worker. Five minutes
  // (the default) held for the old set; with the export, scheduling and
  // push-relay tests in it, a loaded machine needs more.
  dryRunTimeoutMinutes: 20,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  ignorePatterns: [
    "/.next",
    "/e2e",
    "/docs",
    "/public",
    "/assets",
    "/reports",
    "/playwright-report",
    "/test-results",
    "/tests/integration",
  ],
};

export default config;
