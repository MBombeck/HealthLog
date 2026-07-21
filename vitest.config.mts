import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Pin the host timezone. CI runs UTC; without this a contributor in any
    // other zone sees a different suite than the gate does — verified: a
    // UTC+14 host fails five tests on an otherwise green tree. Pinning makes
    // local and CI agree, and makes "which zone does this test mean?" an
    // explicit choice the fixture has to state rather than a property of the
    // machine it runs on. Tests that need a different HOST zone set
    // `process.env.TZ` themselves and restore it afterwards (see
    // `next-due-day-label.test.ts`).
    env: { TZ: "UTC" },
    // Primes the i18n locale cache so provider mounts resolve every
    // locale synchronously (production gets the active bundle as an RSC
    // prop instead — see src/lib/i18n/load-locale.ts).
    setupFiles: ["./vitest.setup.ts"],
    // Default `pnpm test` keeps unit tests only — integration suite uses
    // testcontainers and runs separately via `pnpm test:integration`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "tests/integration/**",
      // Playwright E2E suite — driven separately via `pnpm e2e`.
      "e2e/**",
      // Local agent worktrees create copies of `src/` under `.claude/`
      // or `.worktrees/`; vitest must not collect stale duplicate suites.
      ".claude/worktrees/**",
      ".worktrees/**",
    ],
    coverage: {
      provider: "v8",
      // `include` enumerates the full source tree so the report shows
      // per-file coverage for files never imported by a test (vitest 4
      // dropped the `coverage.all` flag and uses `include` for this).
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/generated/**",
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
