/**
 * Send-policy pins for the Apple Health import queue (issue #486).
 *
 * The queue defaults (retryLimit 2, expireInSeconds 900) redelivered a
 * long-running import after its staged `/tmp` upload was already
 * consumed: the re-run failed on the deleted file and overwrote the
 * first run's terminal state with a raw ENOENT. The kick-off sends must
 * therefore disable retries and widen the expiration past the largest
 * observed exports — and BOTH kick-off routes (user + admin) must
 * actually pass the shared policy, or the default silently returns.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {},
  toJson: (value: unknown) => value,
}));

import {
  APPLE_HEALTH_IMPORT_PARSER_REVISION,
  APPLE_HEALTH_IMPORT_SEND_OPTIONS,
} from "../apple-health-import-worker";
import {
  APPLE_HEALTH_IMPORT_LEGACY_QUEUE,
  APPLE_HEALTH_IMPORT_V2_QUEUE,
} from "@/lib/jobs/apple-health-import-queue";
import {
  handleAppleHealthImportJobs,
  handleLegacyAppleHealthImportJobs,
} from "@/lib/jobs/reminder/maintenance-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const ROUTE_FILES = [
  "src/app/api/import/apple-health-export/route.ts",
  "src/app/api/admin/import-apple-health-export/route.ts",
];

const workerSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/apple-health-import-worker.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/0263_apple_health_aggregate_authority/migration.sql",
  ),
  "utf8",
);
const schemaSource = readFileSync(
  join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);

describe("apple health import — pg-boss send policy", () => {
  it("disables retries and widens the expiration window", () => {
    // retryLimit 0: the staged upload is unlinked by the first run, so
    // a retry can only mask the original outcome behind an ENOENT.
    expect(APPLE_HEALTH_IMPORT_SEND_OPTIONS.retryLimit).toBe(0);
    // Expiration must exceed the 15-minute queue default by a wide
    // margin — GB-scale exports parse for well over an hour.
    expect(
      APPLE_HEALTH_IMPORT_SEND_OPTIONS.expireInSeconds,
    ).toBeGreaterThanOrEqual(60 * 60);
  });

  it("both kick-off routes send with the shared policy", () => {
    for (const file of ROUTE_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toMatch(
        /boss\.send\(\s*APPLE_HEALTH_IMPORT_V2_QUEUE,\s*payload,\s*APPLE_HEALTH_IMPORT_SEND_OPTIONS,?\s*\)/,
      );
    }
  });
});

describe("apple health import — parser revision boundary", () => {
  it("isolates revision-3 sends from legacy workers", () => {
    expect(APPLE_HEALTH_IMPORT_PARSER_REVISION).toBe(3);
    expect(APPLE_HEALTH_IMPORT_V2_QUEUE).toBe("apple-health-import-v2");
    expect(APPLE_HEALTH_IMPORT_LEGACY_QUEUE).toBe("apple-health-import");
  });

  it("drains current-parser jobs separately while bridging legacy backlog", async () => {
    expect(groupOf(APPLE_HEALTH_IMPORT_V2_QUEUE).name).toBe("maintenance");
    expect(groupOf(APPLE_HEALTH_IMPORT_LEGACY_QUEUE).name).toBe("maintenance");
    // Only the current-parser queue runs in the heavy lane; the legacy
    // bridge re-sends its backlog onto it.
    expect(jobOf(APPLE_HEALTH_IMPORT_V2_QUEUE).lane).toBe(true);
    expect(jobOf(APPLE_HEALTH_IMPORT_LEGACY_QUEUE).lane).toBeUndefined();
    expect(await loadedHandler(APPLE_HEALTH_IMPORT_V2_QUEUE)).toBe(
      handleAppleHealthImportJobs,
    );
    expect(await loadedHandler(APPLE_HEALTH_IMPORT_LEGACY_QUEUE)).toBe(
      handleLegacyAppleHealthImportJobs,
    );
  });

  it("keeps the database default at revision 1 for legacy binaries", () => {
    expect(migrationSource).toMatch(
      /ADD COLUMN "parser_revision" INTEGER NOT NULL DEFAULT 1/,
    );
    expect(migrationSource).not.toMatch(
      /ALTER COLUMN "parser_revision" SET DEFAULT 2/,
    );
    expect(schemaSource).toMatch(
      /parserRevision\s+Int\s+@default\(1\)\s+@map\("parser_revision"\)/,
    );
  });

  it("explicitly creates current-revision stand-ins and reconciles only current-revision mirrors", () => {
    expect(workerSource).toMatch(
      /importJob\.create\([\s\S]{0,400}parserRevision:\s*APPLE_HEALTH_IMPORT_PARSER_REVISION/,
    );
    expect(workerSource).toMatch(
      /importJob\.findMany\(\{\s*where:\s*\{[\s\S]{0,200}parserRevision:\s*APPLE_HEALTH_IMPORT_PARSER_REVISION/,
    );
  });
});
