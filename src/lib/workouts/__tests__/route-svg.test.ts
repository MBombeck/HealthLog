import { describe, it, expect } from "vitest";

import {
  projectRoute,
  rdpSimplify,
  buildElevationProfile,
  haversineMeters,
  buildGpxDocument,
  type RouteCoordinate,
} from "@/lib/workouts/route-svg";

/** A ring of `n` points around (lon0, lat0) with per-axis degree radii. */
function ring(
  lon0: number,
  lat0: number,
  dLon: number,
  dLat: number,
  n = 40,
): RouteCoordinate[] {
  const out: RouteCoordinate[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push([lon0 + dLon * Math.cos(a), lat0 + dLat * Math.sin(a)]);
  }
  return out;
}

describe("projectRoute cos(midLat) correction", () => {
  it("squashes the longitude axis by cos(midLat) at 50°N", () => {
    // A box twice as wide in DEGREES of longitude as in latitude. In
    // real metres a degree of longitude at 50°N is only cos(50°) as long
    // as a degree of latitude, so the projected aspect (ySpan/xSpan) must
    // be 1 / (2·cos(50°)) ≈ 0.778 — NOT the uncorrected 0.5 the old
    // normalisation produced. Both stay inside the [0.4, 1.4] clamp band.
    const box = ring(11.0, 50.0, 0.02, 0.01, 30);
    const projected = projectRoute(box);
    expect(projected).not.toBeNull();
    const aspect = projected!.height / projected!.width;
    const corrected = 1 / (2 * Math.cos(50 * (Math.PI / 180))); // ≈ 0.778
    expect(aspect).toBeGreaterThan(corrected * 0.95);
    expect(aspect).toBeLessThan(corrected * 1.05);
    // And distinctly above the uncorrected 0.5 the stretch bug gave.
    expect(aspect).toBeGreaterThan(0.6);
  });

  it("clamps an extreme out-and-back sliver to the minimum height", () => {
    // A near-straight east-west line — ySpan ≈ 0 → the aspect clamp
    // floors the height at 40 rather than a 0-tall sliver.
    const coords: RouteCoordinate[] = [];
    for (let i = 0; i < 30; i++)
      coords.push([11.0 + i * 0.001, 50.0 + i * 1e-6]);
    const projected = projectRoute(coords);
    expect(projected).not.toBeNull();
    expect(projected!.height).toBe(40);
    expect(projected!.viewBox).toBe("0 0 100 40.00");
  });

  it("rejects a degenerate point-shaped route (< 10 points)", () => {
    expect(
      projectRoute([
        [11, 50],
        [11.0001, 50.0001],
        [11.0002, 50.0002],
      ]),
    ).toBeNull();
  });

  it("rejects a route whose real-world span is under ~30 m", () => {
    // 15 points but jittering inside a ~5 m box.
    const coords: RouteCoordinate[] = [];
    for (let i = 0; i < 15; i++) {
      coords.push([11.0 + i * 0.00001, 50.0 + (i % 2) * 0.00001]);
    }
    expect(projectRoute(coords)).toBeNull();
  });

  it("emits start and end markers and a valid path", () => {
    const box = ring(11.0, 50.0, 0.02, 0.02, 30);
    const projected = projectRoute(box)!;
    expect(projected.path.startsWith("M")).toBe(true);
    expect(projected.pointCount).toBeGreaterThanOrEqual(4);
    expect(projected.start).toHaveProperty("x");
    expect(projected.end).toHaveProperty("y");
  });
});

describe("rdpSimplify", () => {
  it("collapses collinear points but keeps corners", () => {
    const line: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 3],
    ];
    const out = rdpSimplify(line, 0.01);
    // The four collinear x-axis points collapse to the two endpoints of
    // that run; the corner at [3,0] and the terminus [3,3] survive.
    expect(out).toEqual([
      [0, 0],
      [3, 0],
      [3, 3],
    ]);
  });

  it("never drops the first or last point", () => {
    const line: Array<[number, number]> = Array.from(
      { length: 100 },
      (_, i) => [i, Math.sin(i)],
    );
    const out = rdpSimplify(line, 0.5);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
    expect(out.length).toBeLessThan(line.length);
  });
});

describe("buildElevationProfile", () => {
  it("returns a cumulative-distance profile when ≥ 60 % carry altitude", () => {
    const coords: RouteCoordinate[] = [
      [11.0, 50.0, 300],
      [11.001, 50.0, 305],
      [11.002, 50.0, 310],
      [11.003, 50.0, 315],
    ];
    const profile = buildElevationProfile(coords)!;
    expect(profile).toHaveLength(4);
    expect(profile[0].distanceM).toBe(0);
    expect(profile[3].distanceM).toBeGreaterThan(profile[0].distanceM);
    expect(profile[3].altitude).toBe(315);
  });

  it("returns null below the altitude-coverage threshold", () => {
    const coords: RouteCoordinate[] = [
      [11.0, 50.0, 300],
      [11.001, 50.0],
      [11.002, 50.0],
      [11.003, 50.0],
    ];
    expect(buildElevationProfile(coords)).toBeNull();
  });
});

describe("haversineMeters", () => {
  it("measures ~111 km for one degree of latitude", () => {
    const d = haversineMeters(11, 50, 11, 51);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("buildGpxDocument", () => {
  it("writes the instant of a stored sample object", () => {
    const gpx = buildGpxDocument({
      coordinates: [
        [11.0, 50.0],
        [11.001, 50.001],
      ],
      timestamps: [
        { t: "2026-05-15T07:00:00Z", hr: 120 },
        { t: "2026-05-15T07:00:05Z", speedMs: 3.1 },
      ],
      sportType: "running",
      startedAt: "2026-05-15T07:00:00Z",
    });
    expect(gpx).toContain("<time>2026-05-15T07:00:00Z</time>");
    expect(gpx).toContain("<time>2026-05-15T07:00:05Z</time>");
  });

  it("emits trkpt elements with elevation and time when present", () => {
    const gpx = buildGpxDocument({
      coordinates: [
        [11.0, 50.0, 300],
        [11.001, 50.001, 305],
      ],
      timestamps: ["2026-05-15T07:00:00Z", "2026-05-15T07:00:05Z"],
      sportType: "running",
      startedAt: "2026-05-15T07:00:00Z",
    });
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('lat="50" lon="11"');
    expect(gpx).toContain("<ele>300</ele>");
    expect(gpx).toContain("<time>2026-05-15T07:00:05Z</time>");
  });
});
