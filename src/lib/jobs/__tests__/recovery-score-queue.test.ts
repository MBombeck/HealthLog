/**
 * Computed scores: recovery-score queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the status group,
 * scheduled on its cron, and bound to the handler that runs the pass. An
 * unregistered queue silently never drains (the recurring past bug this
 * guards against).
 *
 * Also pins the iOS-write rejection of the server-owned COMPUTED source on
 * the batch ingest route: the `batchSourceEnum` allowlist must stay exactly
 * `{APPLE_HEALTH, MANUAL}`, so COMPUTED (like WITHINGS / IMPORT) can never be
 * forged by a client.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RECOVERY_SCORE_CRON,
  RECOVERY_SCORE_QUEUE,
} from "@/lib/jobs/recovery-score-queue";
import { handleRecoveryScore } from "@/lib/jobs/reminder/status-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const BATCH_ROUTE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "app",
  "api",
  "measurements",
  "batch",
  "route.ts",
);
const batchSource = readFileSync(BATCH_ROUTE_PATH, "utf8");

describe("recovery-score registration", () => {
  it("declares the recovery-score queue in the status group", () => {
    expect(groupOf(RECOVERY_SCORE_QUEUE).name).toBe("status");
  });

  it("schedules the recovery-score cron", () => {
    const job = jobOf(RECOVERY_SCORE_QUEUE);
    expect(job.cron).toBe(RECOVERY_SCORE_CRON);
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the handler that runs the recovery-score pass", async () => {
    expect(await loadedHandler(RECOVERY_SCORE_QUEUE)).toBe(handleRecoveryScore);
  });
});

describe("measurements batch route — COMPUTED iOS-write rejection", () => {
  it("keeps the batch source allowlist to APPLE_HEALTH + MANUAL only", () => {
    // The server-owned sources (COMPUTED / WITHINGS / IMPORT) are excluded
    // by construction: the client-facing batch enum is exactly this pair.
    expect(batchSource).toMatch(
      /batchSourceEnum\s*=\s*z\.enum\(\[\s*"APPLE_HEALTH"\s*,\s*"MANUAL"\s*\]\)/,
    );
    expect(batchSource).not.toMatch(/batchSourceEnum[\s\S]{0,80}"COMPUTED"/);
  });
});
