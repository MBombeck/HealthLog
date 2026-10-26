/**
 * TLS-pin-monitor queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the maintenance group,
 * scheduled on its cron with the default retries, and bound to the handler
 * that runs the monitor pass. An unregistered queue silently never drains
 * (the dead-queue class), which would leave the pinned-leaf-rotation alarm
 * dark.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleTlsPinMonitor } from "@/lib/jobs/reminder/ops-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import {
  TLS_PIN_MONITOR_CRON,
  TLS_PIN_MONITOR_QUEUE,
} from "@/lib/jobs/tls-pin-monitor-queue";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "ops-handlers.ts"),
  "utf8",
);

describe("tls-pin-monitor registration", () => {
  it("imports the monitor pass into the ops handlers", () => {
    expect(handlerSource).toMatch(/\brunTlsPinMonitor\b/);
  });

  it("declares the tls-pin-monitor queue in the maintenance group", () => {
    expect(groupOf(TLS_PIN_MONITOR_QUEUE).name).toBe("maintenance");
  });

  it("schedules the tls-pin-monitor cron with the default retries", () => {
    const job = jobOf(TLS_PIN_MONITOR_QUEUE);
    expect(job.cron).toBe(TLS_PIN_MONITOR_CRON);
    expect(job.scheduleOptions).toBeUndefined();
  });

  it("binds the monitor handler", async () => {
    expect(await loadedHandler(TLS_PIN_MONITOR_QUEUE)).toBe(
      handleTlsPinMonitor,
    );
  });

  it("runs the monitor pass inside the handler", () => {
    expect(handlerSource).toMatch(
      /handleTlsPinMonitor[\s\S]{0,400}runTlsPinMonitor/,
    );
  });
});
