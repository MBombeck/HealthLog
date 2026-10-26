import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDurationSequencer } from "./tests/durations/sequencer";
import { classifyUnitFiles } from "./tests/unit-projects";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Four projects. Three run in Node and are decided per file from its source
 * (`tests/unit-projects.ts`): `guards` and `unit` share a module graph inside
 * a worker (`isolate: false`), because their files neither mock nor stub
 * anything; `isolated` keeps one fresh graph per file for the ones that do.
 * The fourth, `browser`, runs `*.browser.test.tsx` in headless Chromium for
 * components whose behaviour is interaction (see `tests/browser/`). Run one
 * with `pnpm test --project guards`.
 */
/** Files the `browser` project owns; no Node project collects them. */
const BROWSER_TEST = /\.browser\.test\.tsx$/;

const projectFiles = classifyUnitFiles(
  __dirname,
  globSync(
    [
      "src/**/*.test.{ts,tsx}",
      "scripts/__tests__/**/*.test.ts",
      "eslint-plugins/**/__tests__/**/*.test.mjs",
      "tests/**/*.test.ts",
    ],
    {
      cwd: __dirname,
      exclude: (path) =>
        path.startsWith("tests/integration") ||
        path.includes("node_modules") ||
        BROWSER_TEST.test(path),
    },
  ).sort(),
);

/** What the three Node projects share; the browser project sets its own. */
const nodeTest = {
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
};

export default defineConfig({
  test: {
    // `--shard` splits by measured duration rather than file count, and files
    // start longest first. See `tests/durations/sequencer.ts`.
    sequence: {
      sequencer: createDurationSequencer("tests/durations/unit.json", 0.4),
    },
    // Default `pnpm test` keeps unit tests only — integration suite uses
    // testcontainers and runs separately via `pnpm test:integration`.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "tests/integration/**",
      // Playwright E2E suite — driven separately via `pnpm e2e`.
      "e2e/**",
      // Local tool worktrees create full copies of `src/` in the repo root;
      // vitest must not collect stale duplicate suites from them. The copies
      // also carry their own `node_modules`, so a collected duplicate drags in
      // a SECOND React instance and fails in ways that have nothing to do with
      // the working tree. `.wt-*` is the convention actually in use — the two
      // names below predate it and are kept because both still occur.
      ".wt-*/**",
      ".claude/worktrees/**",
      ".worktrees/**",
    ],
    projects: [
      {
        extends: true,
        test: {
          ...nodeTest,
          name: "guards",
          include: projectFiles.guards,
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          ...nodeTest,
          name: "unit",
          include: projectFiles.shared,
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          ...nodeTest,
          name: "isolated",
          include: projectFiles.isolated,
        },
      },
      // Not `extends: true` and none of `nodeTest`: the Node setup file reads
      // the file system and mocks the write meter. Each file gets its own
      // page, so a stubbed `fetch` or a rewritten URL cannot leak into the
      // next file.
      {
        resolve: {
          alias: {
            "@": resolve(__dirname, "src"),
            // The App Router's hooks throw outside a mounted router. The shim
            // reads and writes the page's real location instead.
            "next/navigation": resolve(
              __dirname,
              "tests/browser/next-navigation.ts",
            ),
          },
        },
        // Next's client modules (`next/link` among them) read
        // `process.env.*`, which Next's own bundler inlines at build time.
        // A page has no `process`; this inlines an environment with no
        // public variables set, as a build without any would.
        define: {
          "process.env": JSON.stringify({
            NODE_ENV: process.env.NODE_ENV ?? "test",
          }),
        },
        // Pre-bundle every dependency the browser files reach before the
        // first one loads. Discovered late, a dependency makes Vite re-bundle
        // and reload the page mid-run, which fails the file that was
        // importing it; CI starts every run on an empty cache. `force`
        // makes a local run start there too: a cache warmed before a new
        // browser file existed does not know that file's dependencies, and
        // the late re-bundle loads a second React ("Invalid hook call").
        // A cold bundle costs about half a second.
        optimizeDeps: {
          force: true,
          entries: ["src/**/*.browser.test.tsx", "tests/browser/**/*.{ts,tsx}"],
        },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          globals: true,
          setupFiles: ["./tests/browser/setup.ts"],
          browser: {
            enabled: true,
            headless: true,
            // Pinned like the Node projects' `TZ`, so a date the form
            // derives from the clock means the same instant everywhere.
            provider: playwright({
              contextOptions: { timezoneId: "UTC", locale: "en-US" },
            }),
            instances: [{ browser: "chromium" }],
            screenshotFailures: false,
          },
        },
      },
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
