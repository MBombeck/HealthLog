/**
 * v1.7.2 — unit tests for `isDashboardSnapshotEnabled`.
 *
 * The flag flipped default-ON in v1.7.2: the dashboard reads the unified
 * `/api/dashboard/snapshot` cell UNLESS `NEXT_PUBLIC_DASHBOARD_SNAPSHOT`
 * is exactly `"false"`. Pin the boundary so a future edit can't quietly
 * regress to the old `=== "true"` opt-in semantics.
 */
import { describe, it, expect, afterEach } from "vitest";

import { isDashboardSnapshotEnabled } from "../snapshot-flag";

describe("isDashboardSnapshotEnabled", () => {
  const original = process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT;
    } else {
      process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT = original;
    }
  });

  it("defaults ON when the var is unset", () => {
    delete process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT;
    expect(isDashboardSnapshotEnabled()).toBe(true);
  });

  it("stays ON for an empty string", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT = "";
    expect(isDashboardSnapshotEnabled()).toBe(true);
  });

  it("turns OFF only for the exact string \"false\"", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT = "false";
    expect(isDashboardSnapshotEnabled()).toBe(false);
  });

  it('stays ON for "true"', () => {
    process.env.NEXT_PUBLIC_DASHBOARD_SNAPSHOT = "true";
    expect(isDashboardSnapshotEnabled()).toBe(true);
  });
});
