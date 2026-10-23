import { describe, it, expect } from "vitest";

import { computeSplits } from "@/lib/workouts/splits";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";

/**
 * Build a straight eastward track of `n` evenly spaced points spanning
 * `totalKm`, with `secPerKm` pace. One degree of longitude at 50°N is
 * ~71.7 km, but we anchor the math on the actual haversine distance the
 * function computes, so we just space points and let the boundaries
 * fall out.
 */
function track(
  totalMeters: number,
  n: number,
  totalSeconds: number,
): { coords: RouteCoordinate[]; timestamps: string[] } {
  const coords: RouteCoordinate[] = [];
  const timestamps: string[] = [];
  const lat = 0; // equator → a degree of lon ≈ 111.32 km, easy to reason about
  const startMs = Date.parse("2026-05-15T07:00:00Z");
  const totalDeg = totalMeters / 111_320; // metres → degrees lon at equator
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    coords.push([f * totalDeg, lat]);
    timestamps.push(new Date(startMs + f * totalSeconds * 1000).toISOString());
  }
  return { coords, timestamps };
}

describe("computeSplits", () => {
  it("returns one split per full kilometre with interpolated pace", () => {
    // 3.2 km in 960 s → 300 s/km even pace; three full-km boundaries.
    const { coords, timestamps } = track(3200, 320, 960);
    const splits = computeSplits(coords, timestamps)!;
    expect(splits).toHaveLength(3);
    expect(splits[0].km).toBe(1);
    for (const s of splits) {
      expect(s.paceSecPerKm).toBeGreaterThan(285);
      expect(s.paceSecPerKm).toBeLessThan(315);
      expect(s.durationSec).toBe(s.paceSecPerKm);
    }
  });

  it("reads the stored sample shape, an instant with its channels", () => {
    // Both ingests store `{ t, speedMs?, hr? }` per point; older tracks a
    // bare instant. The two shapes time the same track identically.
    const { coords, timestamps } = track(3200, 320, 960);
    const samples = timestamps.map((t, i) => ({ t, hr: 120 + (i % 30) }));
    const splits = computeSplits(coords, samples);
    expect(splits).not.toBeNull();
    expect(splits).toEqual(computeSplits(coords, timestamps));
  });

  it("returns null without aligned timestamps", () => {
    const { coords } = track(3000, 300, 900);
    expect(computeSplits(coords, null)).toBeNull();
    expect(computeSplits(coords, ["2026-05-15T07:00:00Z"])).toBeNull();
  });

  it("returns null under one full kilometre", () => {
    const { coords, timestamps } = track(400, 50, 120);
    expect(computeSplits(coords, timestamps)).toBeNull();
  });
});
