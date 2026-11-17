/**
 * Workout GPS tracks from an Apple Health export, kept only on opt-in.
 *
 * `export.xml` names each workout's track as a `<FileReference>` to a GPX
 * file under `workout-routes/`. The XML pass hands those references here
 * (only when the account turned `storeWorkoutRoutes` on); this module then
 * reads the referenced members one at a time, parses each GPX as a stream,
 * thins it evenly to `MAX_ROUTE_POINTS`, and stores it sealed against the
 * workout the XML pass wrote.
 *
 * Memory: one member is held at a time, inflated into a buffer the archive
 * reader caps (`maxMemberBytes`), and its points are kept as flat number
 * arrays until they are thinned. Nothing about the track goes into the job
 * result, the logs or a wide event: only counts.
 *
 * A failure here never fails the import. The workouts and every measurement
 * are already committed; a track that cannot be read is counted and skipped.
 */
import type { Readable } from "node:stream";

import sax from "sax";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  routeMemberNameFromReference,
  streamAppleHealthRouteMembers,
  type AppleHealthRouteArchiveLimits,
} from "@/lib/apple-health/archive-stream";
import { MAX_ROUTE_POINTS } from "@/lib/validations/workout";
import { encryptRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { routeClimbM } from "@/lib/workouts/route-climb";

/** A workout the XML pass wrote, and the track file it referenced. */
export interface WorkoutRouteReference {
  /** The workout's `externalId` under `source = APPLE_HEALTH`. */
  externalId: string;
  /** The `<FileReference path>` as Apple wrote it. */
  path: string;
}

export interface WorkoutRouteImportCounts {
  /** Tracks the XML referenced that are present in the archive. */
  discovered: number;
  /** Tracks stored against their workout. */
  attached: number;
  /** Workout already had a track, or its row is gone. */
  skipped: number;
  /** Unreadable, too short, or over a limit. */
  failed: number;
}

/** Per-archive ceilings for the route members. */
export const APPLE_HEALTH_ROUTE_ARCHIVE_LIMITS: AppleHealthRouteArchiveLimits =
  {
    maxMembers: 100_000,
    maxRouteMembers: 20_000,
    // A three-hour ride at 1 Hz is a few MB of GPX; 32 MB covers a 24-hour
    // ultra with room to spare and bounds the one buffer held at a time.
    maxMemberBytes: 32 * 1024 * 1024,
    maxTotalRouteBytes: 4 * 1024 * 1024 * 1024,
    maxCompressionRatio: 200,
  };

/** The points of one track, flat: lon, lat, elevation (NaN when absent), time ms (NaN when absent). */
interface ParsedTrack {
  lon: number[];
  lat: number[];
  ele: number[];
  time: number[];
}

/** Stream a GPX document into flat point arrays. Rejects malformed XML. */
export async function parseGpxTrack(stream: Readable): Promise<ParsedTrack> {
  const track: ParsedTrack = { lon: [], lat: [], ele: [], time: [] };
  const parser = sax.parser(true, { trim: true });
  let inPoint = false;
  let field: "ele" | "time" | null = null;
  let ele = Number.NaN;
  let time = Number.NaN;
  let lat = Number.NaN;
  let lon = Number.NaN;
  let failure: Error | null = null;

  parser.onerror = (err) => {
    failure = err instanceof Error ? err : new Error(String(err));
  };
  parser.onopentag = (node) => {
    const name = node.name.toLowerCase();
    if (name === "trkpt") {
      const attrs = node.attributes as Record<string, string>;
      lat = Number.parseFloat(attrs.lat ?? "");
      lon = Number.parseFloat(attrs.lon ?? "");
      ele = Number.NaN;
      time = Number.NaN;
      inPoint = true;
    } else if (inPoint && (name === "ele" || name === "time")) {
      field = name;
    }
  };
  parser.ontext = (text) => {
    if (!inPoint || field === null) return;
    if (field === "ele") ele = Number.parseFloat(text);
    else time = Date.parse(text);
  };
  parser.onclosetag = (tagName) => {
    const name = tagName.toLowerCase();
    if (name === "ele" || name === "time") field = null;
    if (name !== "trkpt") return;
    inPoint = false;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return;
    }
    track.lon.push(lon);
    track.lat.push(lat);
    track.ele.push(Number.isFinite(ele) ? ele : Number.NaN);
    track.time.push(Number.isFinite(time) ? time : Number.NaN);
  };

  for await (const chunk of stream) {
    parser.write(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    if (failure) throw failure;
  }
  parser.close();
  if (failure) throw failure;
  return track;
}

/**
 * Indices that thin `count` points evenly to at most `max`, always keeping
 * the first and the last.
 */
export function thinIndices(count: number, max: number): number[] {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  const step = (count - 1) / (max - 1);
  for (let i = 0; i < max; i += 1) out.push(Math.round(i * step));
  return out;
}

/**
 * The stored shapes for a parsed track: a GeoJSON LineString (altitude only
 * when every kept point has one) and, when every kept point is timed, the
 * parallel sample list. Null for a track with fewer than two points.
 */
export function trackToRoute(track: ParsedTrack): {
  geometry: { type: "LineString"; coordinates: number[][] };
  sampleTimestamps: Array<{ t: string }> | null;
} | null {
  const indices = thinIndices(track.lon.length, MAX_ROUTE_POINTS);
  if (indices.length < 2) return null;
  const withEle = indices.every((i) => Number.isFinite(track.ele[i]));
  const withTime = indices.every((i) => Number.isFinite(track.time[i]));
  return {
    geometry: {
      type: "LineString",
      coordinates: indices.map((i) =>
        withEle
          ? [track.lon[i], track.lat[i], track.ele[i]]
          : [track.lon[i], track.lat[i]],
      ),
    },
    sampleTimestamps: withTime
      ? indices.map((i) => ({ t: new Date(track.time[i]).toISOString() }))
      : null,
  };
}

/**
 * Store the referenced tracks. `references` comes from the XML pass; each
 * names a workout the import wrote under `source = APPLE_HEALTH`.
 */
export async function importAppleHealthWorkoutRoutes(input: {
  archivePath: string;
  userId: string;
  references: readonly WorkoutRouteReference[];
  prisma: Pick<PrismaClient, "workout" | "workoutRoute">;
  limits?: AppleHealthRouteArchiveLimits;
}): Promise<WorkoutRouteImportCounts> {
  const counts: WorkoutRouteImportCounts = {
    discovered: 0,
    attached: 0,
    skipped: 0,
    failed: 0,
  };
  const byMember = new Map<string, string>();
  for (const ref of input.references) {
    const member = routeMemberNameFromReference(ref.path);
    if (member) byMember.set(member, ref.externalId);
  }
  if (byMember.size === 0) return counts;

  try {
    for await (const member of streamAppleHealthRouteMembers({
      archivePath: input.archivePath,
      limits: input.limits ?? APPLE_HEALTH_ROUTE_ARCHIVE_LIMITS,
      wanted: (name) => byMember.has(name),
    })) {
      counts.discovered += 1;
      const externalId = byMember.get(member.name);
      if (!externalId) continue;
      try {
        const route = trackToRoute(await parseGpxTrack(member.stream));
        if (!route) {
          counts.failed += 1;
          continue;
        }
        const workout = await input.prisma.workout.findUnique({
          where: {
            userId_source_externalId: {
              userId: input.userId,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          select: {
            id: true,
            elevationM: true,
            route: { select: { id: true } },
          },
        });
        if (!workout || workout.route) {
          counts.skipped += 1;
          continue;
        }
        await input.prisma.workoutRoute.createMany({
          data: [
            {
              workoutId: workout.id,
              geometryEncrypted: encryptRouteGeometry(route.geometry),
              sampleTimestamps: route.sampleTimestamps ?? undefined,
            },
          ],
          skipDuplicates: true,
        });
        // The climb lives on the workout row, so no reader opens the track
        // for it (the same write-time derivation as the batch route).
        if (workout.elevationM === null) {
          const climb = routeClimbM(route.geometry);
          if (climb !== null) {
            await input.prisma.workout.update({
              where: { id: workout.id },
              data: { elevationM: climb },
            });
          }
        }
        counts.attached += 1;
      } catch {
        counts.failed += 1;
      }
    }
  } catch {
    // The archive itself is unreadable for this pass (a malformed directory,
    // a limit hit in it). Every referenced track not yet handled
    // counts as failed; the import stays done.
    const handled = counts.attached + counts.skipped + counts.failed;
    counts.failed += Math.max(0, byMember.size - handled);
  }
  return counts;
}
