/**
 * The contract of the worker registry, checked over every declaration.
 *
 * The dead-queue class (a queue named but never created, scheduled or
 * drained) cannot be written any more: a definition is the queue, its cron,
 * its policy and its handler in one object, and `registerJobGroup` turns each
 * into all four. What is left to check is what the type system cannot see:
 *
 *   - every queue is declared once, under a well-formed name, and no retired
 *     queue is declared again;
 *   - every cron has five fields, every policy names one this codebase uses
 *     and says why;
 *   - the groups register in the order the worker always used;
 *   - loading the registry loads none of the work: its static import graph
 *     stays inside a small budget and reaches no handler module. A handler is
 *     named only through its definition's dynamic `import("…")`.
 *
 * What pg-boss is left holding after registration is pinned byte for byte by
 * `tests/integration/queue-registration-parity.test.ts`, which also loads
 * every handler once.
 */
import { describe, expect, it } from "vitest";

import { staticImportClosure } from "@/__tests__/helpers/source-metrics";
import { JOB_GROUP_NAMES } from "../define-job";
import { allJobDefinitions, JOB_GROUPS } from "../index";

const definitions = allJobDefinitions();

/** Modules the registry may not load: the work the definitions point at. */
const HANDLER_GRAPH =
  /^lib\/(?:jobs\/reminder\/(?!registrar-shared\.ts|shared\.ts)|ai\/|insights\/|withings\/|whoop\/|oura\/|polar\/|strava\/|google-health\/|nightscout\/|dawarich\/|documents\/|export\/|import\/|measurements\/import)/;

/**
 * Light modules inside those folders the registry may load, with the reason.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "lib/ai/coach/coach-memory-shared.ts":
    "the Coach memory queue's name and payload, with its byte codec; no model code",
  "lib/ai/coach/bytes-codec.ts": "pulled by coach-memory-shared; a codec",
  "lib/ai/ai-budgets.ts":
    "pulled by model-time for the call counts the bounded queues' expiries derive from; constants only",
  "lib/ai/effective-timeout.ts":
    "pulled by model-time for the response-timeout ceiling; arithmetic only, no model code",
  "lib/export/restore-lock.ts":
    "the per-account restore lock the consolidation passes take; a lock primitive",
  "lib/export/restore-failure-cause.ts":
    "pulled by restore-lock; an error type",
};

/**
 * The registry's static graph: the declarations, the light queue-fact
 * modules and the boot infrastructure they share (the database client, the
 * logger, the lane and the lock). Measured at 288 on 2026-10-23, against the
 * 1,164 modules the five hand-written registrars loaded; it may only fall.
 */
const REGISTRY_GRAPH_BUDGET = 300;

describe("worker registry", () => {
  it("declares every queue once, under a well-formed name", () => {
    expect(definitions.length).toBeGreaterThan(100);
    const names = definitions.map((d) => d.queue);
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    expect(twice).toEqual([]);
    expect(names.filter((n) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n))).toEqual(
      [],
    );
  });

  it("declares no retired queue again", () => {
    const declared = new Set(definitions.map((d) => d.queue));
    const retired = JOB_GROUPS.flatMap((g) => g.retired ?? []);
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.filter((q) => declared.has(q))).toEqual([]);
  });

  it("gives every cron five fields and every policy a known kind and a reason", () => {
    const crons = definitions.filter((d) => d.cron);
    expect(crons.length).toBeGreaterThan(60);
    expect(
      crons
        .filter((d) => d.cron!.trim().split(/\s+/).length !== 5)
        .map((d) => d.queue),
    ).toEqual([]);
    const policies = definitions.filter((d) => d.policy);
    expect(policies.length).toBeGreaterThan(30);
    expect(
      policies
        .filter(
          (d) =>
            !["short", "exclusive"].includes(d.policy!.policy) ||
            d.policy!.reason.length < 30,
        )
        .map((d) => d.queue),
    ).toEqual([]);
  });

  it("binds every queue with an explicit concurrency", () => {
    expect(
      definitions
        .filter(
          (d) =>
            !Number.isInteger(d.work.localConcurrency) ||
            (d.work.localConcurrency ?? 0) < 1,
        )
        .map((d) => d.queue),
    ).toEqual([]);
  });

  it("registers the groups in the worker's order", () => {
    expect(JOB_GROUPS.map((g) => g.name)).toEqual([...JOB_GROUP_NAMES]);
  });

  it("loads none of the work when the registry loads", () => {
    const graph = staticImportClosure(["lib/jobs/registry/index.ts"]);
    // A floor, so a walk that resolves nothing cannot pass.
    expect(graph.size).toBeGreaterThan(20);
    expect(graph.has("lib/jobs/registry/maintenance.ts")).toBe(true);
    expect(
      [...graph].filter((m) => HANDLER_GRAPH.test(m) && !(m in ALLOWED)).sort(),
    ).toEqual([]);
    expect(graph.size).toBeLessThanOrEqual(REGISTRY_GRAPH_BUDGET);
  });

  it("catches a handler module in the registry graph (planted)", () => {
    // The same check over the graph a registrar that imported its handlers
    // would have.
    const graph = staticImportClosure(["lib/jobs/reminder/status-handlers.ts"]);
    expect(
      [...graph].filter((m) => HANDLER_GRAPH.test(m)).length,
    ).toBeGreaterThan(0);
  });
});
