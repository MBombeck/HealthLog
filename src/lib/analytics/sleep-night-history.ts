/**
 * Every sleep night of an account as the summaries slice summarises it, with
 * the old nights held as a closed block.
 *
 * The slice summarises sleep over the whole history, one point per night
 * (`summarizeNights`). `readSleepNights` names the nights in Postgres and
 * reconstructs them ninety at a time, so a decade of nights is forty-one
 * reads of stage rows and the reconstruction of every night, on every cold
 * slice, although a night weeks old does not change unless a write reaches
 * it. Here the walk is cut in two at `closedBefore`, the start of the UTC
 * month at least 35 days back: the whole chunks whose stage rows all lie
 * before it are kept as a closed block (`closedBlockKeyPart`), as the points
 * `summarizeNights` reads from them, and only the chunks after are read and
 * reconstructed.
 *
 * The chunks are the walk's own: the same ninety nights from the oldest on,
 * read over the same spans, so every night comes out as the full walk builds
 * it. The night list is read whole every time and the block is used only
 * when its nights and spans are still the first nights of that list; a
 * write that reaches back before `closedBefore` drops it (every measurement
 * write that says how far back it reached spares it otherwise), and so does
 * a new row that joins one of its sessions, which moves that night's span.
 * The key names the zone and the source ladder, which decide the nights.
 */
import { createHash } from "node:crypto";

import { summarize, type DataSummary } from "@/lib/analytics/trends";
import {
  reconstructSleepNights,
  type SleepNight,
} from "@/lib/analytics/sleep-night";
import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  NIGHT_CHUNK,
  readNightSpanRows,
  sleepNightPage,
  type SleepNightSpan,
} from "@/lib/measurements/list/sleep-nights";

const DAY_MS = 24 * 60 * 60 * 1000;

/** No account holds this many nights; the walk is uncapped in practice. */
const ALL_NIGHTS = 100_000;

/** A closed block's lifetime when no write reaches it. */
const CLOSED_NIGHTS_TTL_MS = 15 * 60_000;

interface NightPoint {
  date: Date;
  value: number;
}

interface ClosedNights {
  spans: SleepNightSpan[];
  /** The nights the block's chunks reconstructed, asleep or not. */
  count: number;
  /** The asleep nights' points, oldest first (`summarizeNights`). */
  points: NightPoint[];
  /** The newest asleep night of the block, whole. */
  latest: SleepNight | null;
}

export interface NightHistory {
  /** Every night the walk reconstructed, asleep or not. */
  nightCount: number;
  summary: DataSummary;
  latestNight: SleepNight | null;
}

/** The asleep nights as `summarizeNights` keeps them. */
function asleepPoints(nights: readonly SleepNight[]): {
  points: NightPoint[];
  latest: SleepNight | null;
} {
  const asleep = nights.filter((n) => n.asleepMinutes > 0);
  return {
    points: asleep.map((n) => ({ date: n.measuredAt, value: n.asleepMinutes })),
    latest: asleep.length > 0 ? asleep[asleep.length - 1] : null,
  };
}

/** The UTC month start at least 35 days before `now`. */
export function closedNightsBefore(now: Date): Date {
  const ref = new Date(now.getTime() - 35 * DAY_MS);
  return new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
}

/**
 * How many leading nights fall in whole chunks whose spans all end before
 * `before`: those chunks read no stage row from `before` on.
 */
function closedPrefixLength(spans: SleepNightSpan[], before: Date): number {
  let k = 0;
  let maxEnd = -Infinity;
  for (let i = 0; i < spans.length; i++) {
    maxEnd = Math.max(maxEnd, spans[i].spanEnd.getTime());
    if (maxEnd >= before.getTime()) break;
    if ((i + 1) % NIGHT_CHUNK === 0) k = i + 1;
  }
  return k;
}

function sameSpans(a: SleepNightSpan[], b: SleepNightSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].night !== b[i].night ||
      a[i].spanStart.getTime() !== b[i].spanStart.getTime() ||
      a[i].spanEnd.getTime() !== b[i].spanEnd.getTime()
    ) {
      return false;
    }
  }
  return true;
}

/** Read and reconstruct `spans` in chunks of the walk, oldest first. */
async function walk(
  userId: string,
  tz: string,
  priorityJson: unknown,
  spans: SleepNightSpan[],
): Promise<SleepNight[]> {
  const out: SleepNight[] = [];
  for (let i = 0; i < spans.length; i += NIGHT_CHUNK) {
    const chunk = spans.slice(i, i + NIGHT_CHUNK);
    const keys = new Set(chunk.map((n) => n.night));
    const rows = await readNightSpanRows(userId, chunk);
    for (const night of reconstructSleepNights(rows, tz, priorityJson)) {
      if (keys.has(night.night)) out.push(night);
    }
  }
  return out;
}

/**
 * The night summary of the whole history: what `summarizeNights` returns over
 * `readSleepNights(userId, tz, priorityJson, { maxNights: ALL_NIGHTS })`, and
 * how many nights that walk found.
 */
export async function readNightHistory(
  userId: string,
  tz: string,
  priorityJson: unknown,
  now: Date = new Date(),
): Promise<NightHistory> {
  const { nights: spans } = await sleepNightPage(userId, tz, {
    sortDir: "asc",
    limit: ALL_NIGHTS,
    offset: 0,
  });
  const before = closedNightsBefore(now);
  const k = closedPrefixLength(spans, before);
  const prefix = spans.slice(0, k);
  let closed: ClosedNights | null = null;
  if (k > 0) {
    const ladder = createHash("sha256")
      .update(JSON.stringify(priorityJson ?? null))
      .digest("base64url")
      .slice(0, 16);
    const cache = caches.analytics as ServerCache<ClosedNights>;
    const key = `${userId}|sleep-night-history|${closedBlockKeyPart(before)}|${tz}|${ladder}`;
    const build = async (): Promise<ClosedNights> => {
      const nights = await walk(userId, tz, priorityJson, prefix);
      return { spans: prefix, count: nights.length, ...asleepPoints(nights) };
    };
    closed = (await cache.wrap(key, build, CLOSED_NIGHTS_TTL_MS)).value;
    if (!sameSpans(closed.spans, prefix)) {
      // The block was built over another night list: a session grew across
      // its edge. Rebuild it from the current one.
      cache.delete(key);
      closed = (await cache.wrap(key, build, CLOSED_NIGHTS_TTL_MS)).value;
    }
  }
  const recentNights = await walk(userId, tz, priorityJson, spans.slice(k));
  const recent = asleepPoints(recentNights);
  return {
    nightCount: (closed?.count ?? 0) + recentNights.length,
    summary: summarize([...(closed?.points ?? []), ...recent.points]),
    latestNight: recent.latest ?? closed?.latest ?? null,
  };
}
