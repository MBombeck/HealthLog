/**
 * Unit-test setup.
 *
 * Seed the client-side locale cache with the EN bundle. In production
 * only the active locale reaches the client (boot script, then dynamic
 * import on switch — see `src/lib/i18n/load-locale.ts`). Tests mount
 * `I18nProvider` standalone — often with `renderToStaticMarkup`, which
 * is synchronous and cannot await a dynamic import — so EN, the fallback
 * floor of the t() chain, is primed up front.
 *
 * Only EN. Every catalog is several hundred kilobytes and this file runs
 * once per test file, so priming all of them made setup the largest share
 * of a unit run. A test that renders another locale primes it itself:
 *
 *   import deMessages from "../../../messages/de.json";
 *   primeMessages("de", deMessages);
 *
 * Server-side translation (`getServerTranslator`, `shared-resolve`) holds
 * every catalog on its own and needs no priming.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import { quarantineEntryFor } from "./tests/quarantine/quarantine";
import { watchSwallowedMockErrors } from "./tests/support/swallowed-mock-errors";
import { primeMessages } from "@/lib/i18n/load-locale";
import enMessages from "./messages/en.json";

primeMessages("en", enMessages);

/**
 * Leave no background work in flight when a test ends.
 *
 * Several paths start a promise, return without awaiting it, and log on the
 * detached handle so the failure is not swallowed. Vitest forwards every
 * console write to the main thread as an `onUserConsoleLog` RPC call and
 * rejects whatever is still pending on that channel while it tears a test file
 * down, so a write that lands in that window fails the whole run with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
 * — blamed on the file the worker was tearing down, which is not the test that
 * started the work and need not log anything of its own. Awaiting the
 * registered tasks here removes the precondition instead of muting the
 * console, which would have thrown away a real signal and left the
 * non-determinism in place. See `src/lib/logging/background-tasks.ts`.
 */
const checkSwallowedMockErrors = watchSwallowedMockErrors();

afterEach(async () => {
  await settleBackgroundTasks();
  // A caught "missing mock export" error fails the test it happened in
  // (`tests/support/swallowed-mock-errors.ts`).
  checkSwallowedMockErrors();
});

/**
 * Skip a test on the flaky-test quarantine list until its entry expires. See
 * `tests/quarantine/quarantine.ts` and docs/contributing/testing.md.
 */
beforeEach((context) => {
  const entry = quarantineEntryFor(context.task);
  if (entry) {
    context.skip(`quarantined until ${entry.expires} (${entry.issue})`);
  }
});

/**
 * The shared write ceiling is charged by every identity resolver on a write
 * (`src/lib/auth/write-meter.ts`), which is a database round-trip most route
 * tests have no fake for: their Prisma mock carries the models the handler
 * touches and nothing else. The meter is therefore a no-op in unit tests by
 * default. Its own behaviour is pinned by
 * `src/lib/auth/__tests__/write-meter.test.ts`, which loads the real module,
 * and against Postgres by `tests/integration/write-meter.test.ts`; a route test
 * that wants the refusal mocks `meterAccountWrite` to throw.
 */
vi.mock("@/lib/auth/write-meter", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/write-meter")>();
  return { ...actual, meterAccountWrite: vi.fn(async () => undefined) };
});
