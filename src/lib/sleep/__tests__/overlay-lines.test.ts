import { describe, expect, it } from "vitest";

import {
  buildOverlayRows,
  rawKey,
  soloKey,
  type OverlayLineInput,
} from "@/lib/sleep/overlay-lines";

/**
 * The rows the night timeline draws its lines from (#1419): short gaps
 * bridged for drawing only, long gaps left open (long for the line's own
 * spacing, or past its metric's limit), a lone reading marked as a point,
 * and a row on each edge of the session.
 */

const GRID_FROM = Date.parse("2026-06-03T20:45:00.000Z");
const BUCKET = 5 * 60_000;
const FROM = GRID_FROM + 15 * 60_000;
const TO = FROM + 2 * 3_600_000;

const at = (idx: number) => new Date(GRID_FROM + idx * BUCKET).toISOString();

function line(
  key: string,
  points: Array<[number, number]>,
  maxBridgeMinutes = 20,
): OverlayLineInput {
  return {
    key,
    points: points.map(([i, v]) => ({ at: at(i), value: v })),
    maxBridgeMinutes,
  };
}

function build(points: Array<[number, number]>, toMs = TO) {
  return buildOverlayRows({
    lines: [line("pulse", points)],
    gridFromMs: GRID_FROM,
    bucketMs: BUCKET,
    fromMs: FROM,
    toMs,
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

  it("never draws a sparse series across hours", () => {
    // HRV about once an hour: its own spacing would allow a three-hour line,
    // its metric allows twenty minutes. Every reading stands alone.
    const { rows } = buildOverlayRows({
      lines: [
        line(
          "hrv",
          [3, 15, 27, 39].map((i, n) => [i, 40 + n]),
        ),
      ],
      gridFromMs: GRID_FROM,
      bucketMs: BUCKET,
      fromMs: FROM,
      toMs: FROM + 5 * 3_600_000,
    });
    for (let idx = 4; idx < 39; idx++) {
      if (idx === 15 || idx === 27) continue;
      expect(valueAt(rows, idx, "hrv")).toBeNull();
    }
    for (const idx of [3, 15, 27, 39]) {
      expect(valueAt(rows, idx, rawKey("hrv"))).not.toBeNull();
      expect(valueAt(rows, idx, soloKey("hrv"))).toBe(1);
    }
  });

  it("breaks at the metric's limit even inside its own spacing", () => {
    // Every 10 minutes, then 25: three times the spacing would bridge the
    // 25 minutes, the 20-minute limit does not.
    const { rows } = build([
      [3, 60],
      [5, 61],
      [7, 62],
      [12, 58],
      [14, 57],
    ]);
    expect(valueAt(rows, 6)).toBeCloseTo(61.5);
    expect(valueAt(rows, 9)).toBeNull();
    expect(valueAt(rows, 13)).toBeCloseTo(57.5);
  });

  it("lets a slow metric bridge what a fast one may not", () => {
    // A room thermometer every 15 minutes with one reading missed: 30
    // minutes, inside its own spacing and inside the hour a room allows.
    const { rows } = buildOverlayRows({
      lines: [
        line(
          "roomTemperature",
          [
            [3, 19],
            [6, 18.8],
            [12, 18.2],
            [15, 18],
          ],
          60,
        ),
      ],
      gridFromMs: GRID_FROM,
      bucketMs: BUCKET,
      fromMs: FROM,
      toMs: TO,
    });
    expect(valueAt(rows, 9, "roomTemperature")).toBeCloseTo(18.5);
    expect(valueAt(rows, 6, soloKey("roomTemperature"))).toBeNull();
  });

  it("marks only a reading no line reaches", () => {
    const { rows } = build([
      [3, 60],
      [4, 61],
      [20, 58],
    ]);
    expect(valueAt(rows, 3, soloKey("pulse"))).toBeNull();
    expect(valueAt(rows, 4, soloKey("pulse"))).toBeNull();
    expect(valueAt(rows, 20, soloKey("pulse"))).toBe(1);
    expect(valueAt(rows, 12, soloKey("pulse"))).toBeNull();
  });

  it("keeps a wide grid's adjacent readings joined under a short limit", () => {
    // Buckets wider than the limit: neighbours still connect, nothing more.
    const wide = 30 * 60_000;
    const { rows } = buildOverlayRows({
      lines: [
        {
          key: "pulse",
          points: [0, 1, 3].map((i) => ({
            at: new Date(GRID_FROM + i * wide).toISOString(),
            value: 60 + i,
          })),
          maxBridgeMinutes: 20,
        },
      ],
      gridFromMs: GRID_FROM,
      bucketMs: wide,
      fromMs: GRID_FROM,
      toMs: GRID_FROM + 4 * wide,
    });
    const v = (idx: number, key = "pulse") =>
      rows.find((r) => r.t === GRID_FROM + idx * wide)?.[key];
    expect(v(1)).toBe(61);
    expect(v(2)).toBeNull();
    expect(v(3, soloKey("pulse"))).toBe(1);
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
