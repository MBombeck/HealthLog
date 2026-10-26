/**
 * Mcp-token-cleanup queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the maintenance group,
 * scheduled with the cron as its retry, and bound to the cleanup handler. An
 * unregistered queue silently never drains (the dead-queue class), which
 * would leave expired MCP connector access tokens growing unbounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleMcpTokenCleanup } from "@/lib/jobs/reminder/cleanup-handlers";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const QUEUE = "mcp-token-cleanup";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "cleanup-handlers.ts"),
  "utf8",
);

describe("mcp-token-cleanup registration", () => {
  it("declares the queue in the maintenance group", () => {
    expect(groupOf(QUEUE).name).toBe("maintenance");
  });

  it("schedules the daily cron with the cron as the retry", () => {
    const job = jobOf(QUEUE);
    expect(job.cron).toBe("0 4 * * *");
    expect(job.scheduleOptions).toBe(cronIsTheRetry);
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the cleanup handler", async () => {
    expect(await loadedHandler(QUEUE)).toBe(handleMcpTokenCleanup);
  });

  it("prunes MCP tokens inside the handler", () => {
    expect(handlerSource).toMatch(
      /handleMcpTokenCleanup[\s\S]{0,400}cleanupExpiredMcpTokens/,
    );
  });
});
