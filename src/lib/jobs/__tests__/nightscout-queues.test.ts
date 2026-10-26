/**
 * pg-boss queue registration for the three poll-only sync layers: Nightscout
 * CGM, Polar, and Oura.
 *
 * Reads the worker registry (the worker pulls heavy infra we don't boot
 * here): each queue is declared in the integration-sync group with its cron
 * and handler — the fast guard against the dead-queue class (a queue declared
 * but never registered, which silently never drains). All three syncs are
 * poll-only (no webhook): a single hourly tick walks every configured
 * account. The queue names live in `integration-poll-queues.ts`, so an OAuth
 * callback can enqueue a connect-time first sync without the handler graph.
 */
import { describe, expect, it } from "vitest";

import {
  NIGHTSCOUT_SYNC_CRON,
  NIGHTSCOUT_SYNC_QUEUE,
  OURA_SYNC_CRON,
  OURA_SYNC_QUEUE,
  POLAR_SYNC_CRON,
  POLAR_SYNC_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import { handleNightscoutSync } from "@/lib/jobs/reminder/nightscout-sync";
import { handleOuraSync } from "@/lib/jobs/reminder/oura-sync";
import { handlePolarSync } from "@/lib/jobs/reminder/polar-sync";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

describe("Nightscout sync queue", () => {
  it("declares the nightscout-sync queue constant", () => {
    expect(NIGHTSCOUT_SYNC_QUEUE).toBe("nightscout-sync");
  });

  it("declares the queue in the integration-sync group", () => {
    expect(groupOf(NIGHTSCOUT_SYNC_QUEUE).name).toBe("integration_sync");
  });

  it("schedules the hourly poll cron", () => {
    expect(jobOf(NIGHTSCOUT_SYNC_QUEUE).cron).toBe(NIGHTSCOUT_SYNC_CRON);
  });

  it("binds the handler for the queue", async () => {
    expect(await loadedHandler(NIGHTSCOUT_SYNC_QUEUE)).toBe(
      handleNightscoutSync,
    );
  });
});

describe("Polar / Oura sync queues", () => {
  // The same dead-queue class applies to the two OAuth-wearable polls shipped
  // alongside Nightscout — assert their registry membership so a future
  // refactor can't silently drop one and starve the sync.
  it("declares the polar-sync and oura-sync queue constants", () => {
    expect(POLAR_SYNC_QUEUE).toBe("polar-sync");
    expect(OURA_SYNC_QUEUE).toBe("oura-sync");
  });

  it("declares POLAR_SYNC_QUEUE in the integration-sync group", () => {
    expect(groupOf(POLAR_SYNC_QUEUE).name).toBe("integration_sync");
  });

  it("declares OURA_SYNC_QUEUE in the integration-sync group", () => {
    expect(groupOf(OURA_SYNC_QUEUE).name).toBe("integration_sync");
  });

  it("schedules the hourly poll cron for both", () => {
    expect(jobOf(POLAR_SYNC_QUEUE).cron).toBe(POLAR_SYNC_CRON);
    expect(jobOf(OURA_SYNC_QUEUE).cron).toBe(OURA_SYNC_CRON);
  });

  it("binds a handler for each queue", async () => {
    expect(await loadedHandler(POLAR_SYNC_QUEUE)).toBe(handlePolarSync);
    expect(await loadedHandler(OURA_SYNC_QUEUE)).toBe(handleOuraSync);
  });
});
