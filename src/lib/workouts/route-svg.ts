/**
 * Client-safe route geometry math for the workout-detail map.
 *
 * PURE — no Prisma, no server imports, no Node APIs. It runs in the
 * browser bundle (the v1.29 client/server-boundary lesson) and turns a
 * stored GeoJSON `LineString` into an inline SVG polyline plus optional
 * elevation profile and a GPX export blob. Nothing here reaches the
 * network: the whole point of self-rendering the route is that the
 * user's track never leaves the origin (binding privacy/CSP decision —
 * no tile server, ever).
 *
 * Projection is equirectangular with a single `cos(midLat)` longitude
 * scale factor. At workout scale (≤ a few tens of km) that is visually
 * exact; the previous uncorrected normalisation stretched a route ~40 %
 * horizontally at 50° N (a circular circuit read as an ellipse). The
 * correction squashes the longitude axis by `cos(midLat)` so one screen
 * unit east equals one screen unit north in real metres.
 */
import { routeSampleInstant } from "@/lib/workouts/route-samples";

export type RouteCoordinate =
  [number, number] | [number, number, number] | number[];

export interface RoutePoint {
  x: number;
  y: number;
}

export interface ProjectedRoute {
  /** SVG path data (`M … L …`) in viewBox units. */
  path: string;
  /** `0 0 W H` — W is fixed at 100, H is the aspect-derived, clamped height. */
  viewBox: string;
  width: number;
  height: number;
  /** Start marker position (viewBox units). */
  start: RoutePoint;
  /** End marker position (viewBox units). */
  end: RoutePoint;
  /** Number of points after RDP downsampling. */
  pointCount: number;
}

export interface ElevationPoint {
  /** Cumulative distance from the route start, metres. */
  distanceM: number;
  /** Altitude, metres. */
  altitude: number;
}

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_320;

/** viewBox width — fixed; height rides the projected aspect ratio. */
const VIEW_W = 100;
/** Aspect clamp so a straight out-and-back can't render as a 4 px sliver. */
const MIN_H = 40;
const MAX_H = 140;
/** Guards against a degenerate "route" (an indoor session's 3 GPS pings). */
const MIN_POINTS = 10;
const MIN_SPAN_M = 30;
/** Shape-preserving downsample ceiling. */
const MAX_RENDER_POINTS = 1200;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Pull the `[lon, lat]` pairs out of a GeoJSON `LineString`'s
 * coordinates, dropping any malformed entry. Altitude (3rd element) is
 * ignored here — `buildElevationProfile` reads it separately.
 */
export function extractLonLat(
  coordinates: readonly RouteCoordinate[],
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = c[0];
    const lat = c[1];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    out.push([lon, lat]);
  }
  return out;
}

/** Great-circle distance between two lon/lat points, metres. */
export function haversineMeters(
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
): number {
  const R = 6_371_000;
  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLon = (bLon - aLon) * DEG_TO_RAD;
  const lat1 = aLat * DEG_TO_RAD;
  const lat2 = bLat * DEG_TO_RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Perpendicular distance from `p` to the segment `a→b` (planar). */
function perpDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker line simplification. Keeps switchbacks that a
 * naive stride would erase. Iterative (an explicit stack) so a
 * 20 000-point ultra can't blow the call stack.
 */
export function rdpSimplify(
  points: ReadonlyArray<[number, number]>,
  tolerance: number,
): Array<[number, number]> {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let maxDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([first, index]);
      stack.push([index, last]);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Uniform stride down to at most `max` points (post-RDP safety cap). */
function strideTo<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return points.slice();
  const step = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Project a GeoJSON LineString into an aspect-true, downsampled SVG
 * path. Returns `null` for a degenerate route (too few points or a
 * bounding box under ~30 m) — the caller then hides the route card
 * rather than painting a meaningless dot.
 */
export function projectRoute(
  coordinates: readonly RouteCoordinate[],
): ProjectedRoute | null {
  const lonLat = extractLonLat(coordinates);
  if (lonLat.length < MIN_POINTS) return null;

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of lonLat) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  const midLat = (minLat + maxLat) / 2;
  const cosMid = Math.cos(midLat * DEG_TO_RAD);

  // Real-world span (metres) — the small-route guard rejects the indoor
  // session that logged a couple of stationary GPS pings.
  const spanXm = (maxLon - minLon) * cosMid * METERS_PER_DEG_LAT;
  const spanYm = (maxLat - minLat) * METERS_PER_DEG_LAT;
  if (Math.hypot(spanXm, spanYm) < MIN_SPAN_M) return null;

  // Projected coordinates: longitude squashed by cos(midLat); latitude
  // flipped so SVG y grows downward.
  const projected: Array<[number, number]> = lonLat.map(([lon, lat]) => [
    (lon - minLon) * cosMid,
    maxLat - lat,
  ]);

  const xSpanRaw = (maxLon - minLon) * cosMid || 1e-9;
  // RDP tolerance derived from the projected bbox (spec: xSpan / 2000).
  let simplified = rdpSimplify(projected, xSpanRaw / 2000);
  if (simplified.length > MAX_RENDER_POINTS) {
    simplified = strideTo(simplified, MAX_RENDER_POINTS);
  }

  // Projected bbox of the (simplified) track + 5 % padding per side.
  let pMinX = Infinity;
  let pMaxX = -Infinity;
  let pMinY = Infinity;
  let pMaxY = -Infinity;
  for (const [x, y] of simplified) {
    if (x < pMinX) pMinX = x;
    if (x > pMaxX) pMaxX = x;
    if (y < pMinY) pMinY = y;
    if (y > pMaxY) pMaxY = y;
  }
  const rawXSpan = pMaxX - pMinX || 1e-9;
  const rawYSpan = pMaxY - pMinY || 1e-9;
  const padX = rawXSpan * 0.05;
  const padY = rawYSpan * 0.05;
  pMinX -= padX;
  pMaxX += padX;
  pMinY -= padY;
  pMaxY += padY;
  const xSpan = pMaxX - pMinX;
  const ySpan = pMaxY - pMinY;

  // Height rides the true aspect ratio (uniform scale when unclamped);
  // the clamp only bites on extreme slivers, where the intentional
  // distortion trades geographic fidelity for on-screen readability.
  const height = Math.max(MIN_H, Math.min(MAX_H, (VIEW_W * ySpan) / xSpan));
  const scaleX = VIEW_W / xSpan;
  const scaleY = height / ySpan;

  const toVB = ([x, y]: [number, number]): RoutePoint => ({
    x: (x - pMinX) * scaleX,
    y: (y - pMinY) * scaleY,
  });

  const vbPoints = simplified.map(toVB);
  const path = vbPoints
    // eslint-disable-next-line healthlog/no-unlocalised-decimal -- SVG path data and viewBox, read by the renderer
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");

  return {
    path,
    // eslint-disable-next-line healthlog/no-unlocalised-decimal -- SVG path data and viewBox, read by the renderer
    viewBox: `0 0 ${VIEW_W} ${height.toFixed(2)}`,
    width: VIEW_W,
    height,
    start: vbPoints[0],
    end: vbPoints[vbPoints.length - 1],
    pointCount: vbPoints.length,
  };
}

/** Fraction of coordinates that carry a finite altitude (3rd element). */
function altitudeCoverage(coordinates: readonly RouteCoordinate[]): number {
  if (coordinates.length === 0) return 0;
  let withAlt = 0;
  for (const c of coordinates) {
    if (Array.isArray(c) && c.length >= 3 && isFiniteNumber(c[2])) withAlt++;
  }
  return withAlt / coordinates.length;
}

/** Minimum altitude coverage before an elevation profile is honest. */
export const ELEVATION_COVERAGE_THRESHOLD = 0.6;

/**
 * Build a cumulative-distance elevation profile when at least 60 % of
 * coordinates carry altitude. Below the threshold partial altimeter
 * data would draw a lie, so this returns `null` and the caller omits
 * the profile.
 */
export function buildElevationProfile(
  coordinates: readonly RouteCoordinate[],
): ElevationPoint[] | null {
  if (altitudeCoverage(coordinates) < ELEVATION_COVERAGE_THRESHOLD) return null;
  const out: ElevationPoint[] = [];
  let cumulative = 0;
  let prev: [number, number] | null = null;
  for (const c of coordinates) {
    if (!Array.isArray(c) || c.length < 3) continue;
    const lon = c[0];
    const lat = c[1];
    const alt = c[2];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat) || !isFiniteNumber(alt)) {
      continue;
    }
    if (prev) cumulative += haversineMeters(prev[0], prev[1], lon, lat);
    out.push({ distanceM: cumulative, altitude: alt });
    prev = [lon, lat];
  }
  return out.length >= 2 ? out : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialise the route geometry to a GPX 1.1 document, entirely
 * client-side over data already loaded — zero server work, zero egress.
 * Timestamps (when present, parallel to the coordinates) are emitted so
 * the exported track round-trips into any GPX consumer.
 */
export function buildGpxDocument(params: {
  coordinates: readonly RouteCoordinate[];
  /** The stored samples: an instant each, or `{ t, … }` (`RouteSample`). */
  timestamps?: readonly unknown[] | null;
  sportType: string;
  startedAt: string;
}): string {
  const { coordinates, timestamps, sportType, startedAt } = params;
  const segments: string[] = [];
  coordinates.forEach((c, i) => {
    if (!Array.isArray(c) || c.length < 2) return;
    const lon = c[0];
    const lat = c[1];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) return;
    const parts = [`<trkpt lat="${lat}" lon="${lon}">`];
    if (c.length >= 3 && isFiniteNumber(c[2])) parts.push(`<ele>${c[2]}</ele>`);
    const ts = routeSampleInstant(timestamps?.[i]);
    if (ts) {
      parts.push(`<time>${escapeXml(ts)}</time>`);
    }
    parts.push(`</trkpt>`);
    segments.push(parts.join(""));
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="HealthLog" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><time>${escapeXml(startedAt)}</time></metadata>`,
    `<trk><name>${escapeXml(sportType)}</name><trkseg>`,
    ...segments,
    `</trkseg></trk>`,
    `</gpx>`,
  ].join("\n");
}
