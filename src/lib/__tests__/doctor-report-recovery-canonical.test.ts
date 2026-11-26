import { describe, it, expect } from "vitest";
import { summariseRecoveryBySource } from "@/lib/doctor-report-data";

function m(type: string, value: number, iso: string, source: string) {
  return { type, value, measuredAt: new Date(iso), source: source as never };
}

describe("summariseRecoveryBySource", () => {
  it("returns no row when no recovery rows exist", () => {
    expect(
      summariseRecoveryBySource([
        m("STRESS_SCORE", 40, "2026-06-01T12:00:00Z", "COMPUTED"),
      ]),
    ).toEqual([]);
  });

  it("prefers the WHOOP-native row over the COMPUTED proxy per night", () => {
    // ONE physiological night (wake morning Jun 1) carries both rows on their
    // real, off-by-one stamps: WHOOP stamps the wake morning (Jun 1), the
    // COMPUTED proxy stamps the day that ended (May 31 noon). The resolver
    // shifts the proxy onto the wake day so they collapse to one night, and the
    // report reads the native value, not a blend, and no proxy row at all.
    const rows = summariseRecoveryBySource([
      m("RECOVERY_SCORE", 50, "2026-05-31T12:00:00Z", "COMPUTED"),
      m("RECOVERY_SCORE", 80, "2026-06-01T06:00:00Z", "WHOOP"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "WHOOP",
      latest: 80,
      avg: 80,
      min: 80,
      max: 80,
      count: 1,
    });
  });

  it("gives one row per source when a window holds WHOOP nights and proxy nights", () => {
    // Night A (wake Jun 1): WHOOP 80 + its COMPUTED proxy 40 (stamped May 31
    // noon) collapse to the native 80. Night B (wake Jun 2): a COMPUTED-only
    // proxy 60, stamped Jun 1 noon, stands alone. One row would have averaged
    // a WHOOP percentage with HealthLog's readiness into 70.
    const rows = summariseRecoveryBySource([
      m("RECOVERY_SCORE", 60, "2026-06-01T12:00:00Z", "COMPUTED"),
      m("RECOVERY_SCORE", 80, "2026-06-01T06:00:00Z", "WHOOP"),
      m("RECOVERY_SCORE", 40, "2026-05-31T12:00:00Z", "COMPUTED"),
    ]);
    expect(rows.map((r) => r.source)).toEqual(["WHOOP", "COMPUTED"]);
    expect(rows[0]).toMatchObject({ latest: 80, avg: 80, count: 1 });
    expect(rows[1]).toMatchObject({ latest: 60, avg: 60, count: 1 });
    for (const r of rows) expect(r.scaleMax).toBe(100);
  });

  it("shows Polar's Nightly Recharge back on its own 1 to 6 scale", () => {
    // Stored rescaled to 0..100 on ingest: status 5 → 80, status 3 → 40.
    const rows = summariseRecoveryBySource([
      m("RECOVERY_SCORE", 80, "2026-06-02T00:00:00Z", "POLAR"),
      m("RECOVERY_SCORE", 40, "2026-06-01T00:00:00Z", "POLAR"),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        source: "POLAR",
        scaleMax: 6,
        latest: 5,
        min: 3,
        max: 5,
        avg: 4,
        count: 2,
      }),
    ]);
  });
});
