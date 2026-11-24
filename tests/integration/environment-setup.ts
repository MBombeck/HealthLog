import { afterAll, afterEach, beforeAll, beforeEach, inject, vi } from "vitest";

import { quarantineEntryFor } from "../quarantine/quarantine";
import { watchSwallowedMockErrors } from "../support/swallowed-mock-errors";
import { readSchemaEntries, schemaDrift } from "./schema-fingerprint";
import { prepareWorkerDatabase } from "./worker-database";

// Each worker runs against its own clone of the migrated template (see
// `worker-database.ts`). The URL is final before any application module is
// imported, so the Prisma singleton is built against the clone.
process.env.DATABASE_URL = await prepareWorkerDatabase(
  inject("integrationDatabaseUrl"),
  inject("integrationDatabasePlan"),
);
process.env.ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
delete process.env.ENCRYPTION_KEYS;
delete process.env.ENCRYPTION_ACTIVE_KEY_ID;
process.env.API_TOKEN_HMAC_KEY = "integration-test-hmac-key-32-bytes-minimum";
process.env.SESSION_SECRET = "integration-test-session-secret-32-bytes";

/**
 * Leave no background work in flight when an integration test ends — the same
 * contract the unit setup keeps, for the same reason: detached background work
 * logs on its own handle, and a console write that reaches vitest after the
 * worker has begun closing its RPC channel fails the run with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.
 * This suite has its own config and its own setup file, so the unit hook does
 * not cover it.
 *
 * The import is deferred: this file's whole job is to bridge DATABASE_URL into
 * the worker BEFORE any application module reads it at import time, and a
 * static import here would pull part of the application tree in first.
 */
/** A swallowed "missing mock export" error fails its test (see the module). */
const checkSwallowedMockErrors = watchSwallowedMockErrors();

afterEach(async () => {
  const { settleBackgroundTasks } =
    await import("@/lib/logging/background-tasks");
  await settleBackgroundTasks();
  checkSwallowedMockErrors();
});

/**
 * A file leaves the worker's schema as it found it (`schema-fingerprint.ts`).
 * Registered here, before the file's own hooks, so this `afterAll` runs after
 * the file's own clean-up.
 */
let schemaAtStart: string[] = [];
beforeAll(async () => {
  schemaAtStart = await readSchemaEntries(process.env.DATABASE_URL ?? "");
});
afterAll(async () => {
  const { added, removed } = schemaDrift(
    schemaAtStart,
    await readSchemaEntries(process.env.DATABASE_URL ?? ""),
  );
  if (added.length > 0 || removed.length > 0) {
    throw new Error(
      [
        "This file changed the schema of the worker database and left it changed; the next file in the worker inherits it. Put the head schema back in an afterAll or finally.",
        ...added.map((e) => `  left behind: ${e}`),
        ...removed.map((e) => `  missing:     ${e}`),
      ].join("\n"),
    );
  }
});

/** The flaky-test quarantine, as in the unit setup (`vitest.setup.ts`). */
beforeEach((context) => {
  const entry = quarantineEntryFor(context.task);
  if (entry) {
    context.skip(`quarantined until ${entry.expires} (${entry.issue})`);
  }
});

/**
 * Route handlers read cookies and headers through `next/headers`, which only
 * works inside a Next.js request scope. Every file gets the same stand-in,
 * backed by the shared jars in `mock-next-headers.ts`, and the same no-op for
 * the boot-time compatibility probe. A file that needs different behaviour
 * still declares its own `vi.mock`, which takes precedence over this one.
 */
vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
      has: (name: string) => headerJar.has(name.toLowerCase()),
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});
