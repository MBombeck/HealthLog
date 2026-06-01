/**
 * v1.8.0 — measurement-driven per-metric assessment invalidation.
 *
 * A fresh measurement of a given type must drop the cached
 * `insights.<scope>-status.<locale>` rows for the scopes that reading
 * dirties, so the next mount / nightly warm pass regenerates them
 * against the new data instead of serving the pre-measurement text for
 * the rest of the day. These tests pin the type → scope mapping and the
 * delete shape without a live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { deleteMany: (...a: unknown[]) => deleteMany(...a) },
  },
}));

import { invalidateStatusInsightsForTypes } from "../comprehensive-generate";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMany.mockResolvedValue({ count: 0 });
});

function deletedScopes(): string[] {
  const arg = deleteMany.mock.calls[0][0];
  // Each OR clause is `{ action: { startsWith: "insights.<scope>-status." } }`.
  return (arg.where.OR as Array<{ action: { startsWith: string } }>)
    .map((c) => c.action.startsWith.replace(/^insights\.(.+)-status\.$/, "$1"))
    .sort();
}

describe("invalidateStatusInsightsForTypes", () => {
  it("maps WEIGHT to weight + bmi + general", async () => {
    await invalidateStatusInsightsForTypes("u1", ["WEIGHT"]);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deletedScopes()).toEqual(["bmi", "general", "weight"]);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("u1");
  });

  it("maps both blood-pressure components to blood-pressure + general", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
    expect(deletedScopes()).toEqual(["blood-pressure", "general"]);
  });

  it("maps PULSE and RESTING_HEART_RATE to pulse + general", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "PULSE",
      "RESTING_HEART_RATE",
    ]);
    expect(deletedScopes()).toEqual(["general", "pulse"]);
  });

  it("maps an unmapped metric to general only", async () => {
    await invalidateStatusInsightsForTypes("u1", ["BLOOD_GLUCOSE"]);
    expect(deletedScopes()).toEqual(["general"]);
  });

  it("dedupes scopes across a mixed batch", async () => {
    await invalidateStatusInsightsForTypes("u1", [
      "WEIGHT",
      "PULSE",
      "BLOOD_GLUCOSE",
    ]);
    // weight + bmi + general (WEIGHT) ∪ pulse + general (PULSE) ∪ general
    expect(deletedScopes()).toEqual([
      "bmi",
      "general",
      "pulse",
      "weight",
    ]);
  });

  it("is a no-op for an empty type set (no DB call)", async () => {
    await invalidateStatusInsightsForTypes("u1", []);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
