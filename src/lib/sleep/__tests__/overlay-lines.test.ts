import { describe, expect, it } from "vitest";

import { buildOverlayRows, rawKey } from "@/lib/sleep/overlay-lines";

/**
 * The rows the night timeline draws its lines from (#1419): short gaps
 * bridged for drawing only, long gaps left open, and a row on each edge of
 * the session.
 */

const GRID_FROM = Date.parse("2026-06-03T20:45:00.000Z");
const BUCKET = 5 * 60_000;
const FROM = GRID_FROM + 15 * 60_000;
const TO = FROM + 2 * 3_600_000;

const at = (idx: number) => new Date(GRID_FROM + idx * BUCKET).toISOString();

function build(points: Array<[number, number]>) {
  return buildOverlayRows({
    lines: [
      {
        key: "pulse",
        points: points.map(([i, v]) => ({ at: at(i), value: v })),
      },
    ],
    gridFromMs: GRID_FROM,
    bucketMs: BUCKET,
    fromMs: FROM,
    toMs: TO,
  });
}

const valueAt = (
  rows: ReturnType<typeof build>["rows"],
  idx: number,
  key = "pulse",
) => rows.find((r) => r.t === GRID_FROM + idx * BUCKET)?.[key];

describe("buildOverlayRows", () => {
  it("bridges a gap of a few buckets for drawing, and shows only readings", () => {
    const { rows } = build([
      [3, 60],
      [5, 64],
      [6, 64],
      [7, 64],
    ]);
    expect(valueAt(rows, 4)).toBe(62);
    expect(valueAt(rows, 4, rawKey("pulse"))).toBeNull();
    expect(valueAt(rows, 5, rawKey("pulse"))).toBe(64);
  });

  it("leaves a long gap open", () => {
    const { rows } = build([
      [3, 60],
      [4, 61],
      [5, 62],
      [20, 58],
      [21, 57],
    ]);
    expect(valueAt(rows, 12)).toBeNull();
  });

  it("bridges a sparse series at its own spacing", () => {
    // Samples every two hours: the line runs between them.
    const { rows } = buildOverlayRows({
      lines: [
        {
          key: "hrv",
          points: [3, 27, 51].map((i, n) => ({ at: at(i), value: 40 + n })),
        },
      ],
      gridFromMs: GRID_FROM,
      bucketMs: BUCKET,
      fromMs: FROM,
      toMs: FROM + 5 * 3_600_000,
    });
    expect(valueAt(rows, 15, "hrv")).toBeCloseTo(40.5);
  });

  it("cuts the rows to the session and gives each edge a row", () => {
    const { rows } = build([
      [0, 70],
      [3, 60],
      [30, 60],
    ]);
    expect(rows[0]!.t).toBe(FROM);
    expect(rows[rows.length - 1]!.t).toBe(TO);
    expect(rows.every((r) => r.t >= FROM && r.t <= TO)).toBe(true);
  });

  it("fills its plot with a margin around the readings", () => {
    const { domains } = build([
      [3, 50],
      [4, 70],
    ]);
    const [lo, hi] = domains.pulse!;
    expect(lo).toBeLessThan(50);
    expect(hi).toBeGreaterThan(70);
  });
});
