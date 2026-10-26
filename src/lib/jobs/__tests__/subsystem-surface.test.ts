/**
 * Every queue the worker registry declares has a failure audience in
 * `SUBSYSTEM_SURFACE`, and the table names no queue the registry has dropped.
 */
import { describe, expect, it } from "vitest";

import { allJobDefinitions } from "@/lib/jobs/registry";
import {
  SUBSYSTEM_SURFACE,
  type SubsystemSurface,
} from "@/lib/jobs/subsystem-surface";

function registeredQueueNames(): string[] {
  return allJobDefinitions().map((job) => job.queue);
}

export function findSurfaceDrift(
  queueNames: readonly string[],
  surfaces: Readonly<Record<string, SubsystemSurface>>,
): { missing: string[]; extra: string[] } {
  const registered = new Set(queueNames);
  const classified = new Set(Object.keys(surfaces));
  return {
    missing: [...registered].filter((name) => !classified.has(name)).sort(),
    extra: [...classified].filter((name) => !registered.has(name)).sort(),
  };
}

function assertSurfaceComplete(
  queueNames: readonly string[],
  surfaces: Readonly<Record<string, SubsystemSurface>>,
): void {
  const drift = findSurfaceDrift(queueNames, surfaces);
  if (drift.missing.length === 0 && drift.extra.length === 0) return;
  throw new Error(
    `Subsystem surface drift: missing=[${drift.missing.join(", ")}], extra=[${drift.extra.join(", ")}]`,
  );
}

describe("SUBSYSTEM_SURFACE", () => {
  it("classifies every current registry queue with no stale entries", () => {
    const names = registeredQueueNames();
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(() => assertSurfaceComplete(names, SUBSYSTEM_SURFACE)).not.toThrow();
  });

  it("requires none reasons to cite a test path or issue", () => {
    for (const surface of Object.values(SUBSYSTEM_SURFACE)) {
      if (surface.audience !== "none") continue;
      expect(surface.reason).toMatch(/^(?:#\d+|.+\.test\.tsx?(?::\d+)?)$/);
    }
  });

  it("catches a new registry queue without a surface entry", () => {
    expect(() =>
      assertSurfaceComplete(["existing-queue", "new-queue"], {
        "existing-queue": { audience: "system" },
      }),
    ).toThrow(/missing=\[new-queue\]/);
  });
});
