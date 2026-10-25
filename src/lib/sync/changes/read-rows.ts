/**
 * The per-domain keyset walks of the delta feed.
 *
 * Live and soft-deleted rows come out of the same scan: a soft-delete bumps
 * `updatedAt`, so a tombstone is just a row whose `deletedAt` is non-null.
 * Each walk fetches `limit + 1` rows to detect `hasMore` without a count
 * query.
 */
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { DomainWatermark, SyncCursor } from "@/lib/sync/cursor";
import { dayLogSymptomInclude } from "@/lib/cycle/dto";
import { APPLE_HEALTH_MIRROR_SELECT } from "@/lib/measurements/apple-health-mirror";

const MEASUREMENT_SELECT = {
  id: true,
  externalId: true,
  type: true,
  value: true,
  unit: true,
  measuredAt: true,
  source: true,
  notes: true,
  notesEncrypted: true,
  syncVersion: true,
  deletedAt: true,
  updatedAt: true,
  ingestToken: APPLE_HEALTH_MIRROR_SELECT.ingestToken,
} satisfies Prisma.MeasurementSelect;

const MOOD_SELECT = {
  id: true,
  date: true,
  mood: true,
  score: true,
  moodA1: true,
  stressA2: true,
  energyA3: true,
  connectionA4: true,
  stabilityA5: true,
  context: true,
  tags: true,
  note: true,
  noteEncrypted: true,
  moodLoggedAt: true,
  source: true,
  syncVersion: true,
  deletedAt: true,
  updatedAt: true,
} satisfies Prisma.MoodEntrySelect;

const INTAKE_SELECT = {
  id: true,
  medicationId: true,
  scheduledFor: true,
  takenAt: true,
  skipped: true,
  source: true,
  autoRecorded: true,
  syncVersion: true,
  deletedAt: true,
  updatedAt: true,
} satisfies Prisma.MedicationIntakeEventSelect;

export type MeasurementRow = Prisma.MeasurementGetPayload<{
  select: typeof MEASUREMENT_SELECT;
}>;
export type MoodRow = Prisma.MoodEntryGetPayload<{
  select: typeof MOOD_SELECT;
}>;
export type IntakeRow = Prisma.MedicationIntakeEventGetPayload<{
  select: typeof INTAKE_SELECT;
}>;
export type CycleDayRow = Prisma.CycleDayLogGetPayload<{
  include: typeof dayLogSymptomInclude;
}>;
export type CycleRow = Prisma.MenstrualCycleGetPayload<object>;
/** A reading the mirror walk re-delivers, with its token's current setting. */
export type MeasurementMirrorRow = Prisma.MeasurementGetPayload<{
  select: {
    id: true;
    source: true;
    ingestToken: {
      select: { mirrorToAppleHealth: true; mirrorChangedAt: true };
    };
  };
}>;

/**
 * Build the `(updatedAt, id)` keyset predicate for a domain's watermark.
 * Empty object (full scan) when the client has no watermark for it yet.
 */
function keysetFilter(wm: DomainWatermark | undefined) {
  if (!wm) return {};
  const at = new Date(wm.updatedAtMs);
  return {
    OR: [
      { updatedAt: { gt: at } },
      { AND: [{ updatedAt: at }, { id: { gt: wm.id } }] },
    ],
  };
}

export interface DomainRows {
  measurements: MeasurementRow[];
  mood: MoodRow[];
  intakes: IntakeRow[];
  cycleDays: CycleDayRow[];
  cycles: CycleRow[];
  measurementMirror: MeasurementMirrorRow[];
}

const MEASUREMENT_MIRROR_ROW_SELECT = {
  id: true,
  source: true,
} satisfies Prisma.MeasurementSelect;

/**
 * The live readings of every token whose Apple Health setting changed past
 * the watermark, in `(token.mirrorChangedAt, measurement.id)` order. Switching
 * the setting writes the token row only, so the readings keep their
 * `updatedAt` (nothing keyed on it recomputes) and arrive through this walk
 * instead of the measurement one.
 *
 * The walk starts from the tokens, not the readings. Ordering readings by a
 * column of the joined token row cannot use any index on `measurements`, so
 * the single-query form sorted every row of every token that had ever been
 * switched, on every poll, even when nothing had changed since the client's
 * watermark. Reading the switched tokens first is a lookup on a handful of
 * rows; nearly every poll finds none and ends there. Otherwise the readings
 * are walked one change stamp at a time, by `(ingest_token_id, id)`, which is
 * the order the index already holds. Tokens that share a stamp are walked
 * together so their rows interleave by id exactly as the one-query form
 * ordered them.
 *
 * The token lookup filters on the token's owner. That is exact because a
 * reading only ever links to a token of its own account: the link is written
 * for a narrow `measurements:write` Bearer, which never acts on another record
 * (`requireRecordAuth` refuses the carrier), and a restore keeps the link only
 * for a token the restoring account holds.
 */
async function readMeasurementMirrorRows(
  userId: string,
  wm: DomainWatermark | undefined,
  limit: number,
): Promise<MeasurementMirrorRow[]> {
  const at = wm ? new Date(wm.updatedAtMs) : null;
  const tokens = await prisma.apiToken.findMany({
    where: {
      userId,
      mirrorChangedAt: at ? { gte: at } : { not: null },
    },
    orderBy: [{ mirrorChangedAt: "asc" }, { id: "asc" }],
    select: { id: true, mirrorToAppleHealth: true, mirrorChangedAt: true },
  });
  if (tokens.length === 0) return [];

  // One group per change stamp, in stamp order.
  const groups: { stampMs: number; tokens: typeof tokens }[] = [];
  for (const token of tokens) {
    const stampMs = token.mirrorChangedAt!.getTime();
    const last = groups[groups.length - 1];
    if (last && last.stampMs === stampMs) last.tokens.push(token);
    else groups.push({ stampMs, tokens: [token] });
  }

  const out: MeasurementMirrorRow[] = [];
  for (const group of groups) {
    const want = limit + 1 - out.length;
    if (want <= 0) break;
    // The watermark's own stamp resumes after the last row delivered; every
    // later stamp starts from its first row.
    const resume = wm && group.stampMs === wm.updatedAtMs ? wm.id : null;
    const byId = new Map(group.tokens.map((t) => [t.id, t]));
    const rows = await prisma.measurement.findMany({
      where: {
        ingestTokenId:
          group.tokens.length === 1
            ? group.tokens[0].id
            : { in: group.tokens.map((t) => t.id) },
        userId,
        deletedAt: null,
        ...(resume !== null && { id: { gt: resume } }),
      },
      orderBy: { id: "asc" },
      take: want,
      select: { ...MEASUREMENT_MIRROR_ROW_SELECT, ingestTokenId: true },
    });
    for (const { ingestTokenId, ...row } of rows) {
      const token = byId.get(ingestTokenId!)!;
      out.push({
        ...row,
        ingestToken: {
          mirrorToAppleHealth: token.mirrorToAppleHealth,
          mirrorChangedAt: token.mirrorChangedAt,
        },
      });
    }
  }
  return out;
}

/**
 * Read one page plus one row of every domain past its watermark. The cycle
 * walks are skipped outright when the module is off, not filtered after the
 * fact, so the disabled rows are never read out of Postgres at all.
 */
export async function readDomainRows(
  userId: string,
  cursor: SyncCursor,
  limit: number,
  cycleEnabled: boolean,
): Promise<DomainRows> {
  const [measurements, mood, intakes, cycleDays, cycles, measurementMirror] =
    await Promise.all([
      prisma.measurement.findMany({
        where: { userId, ...keysetFilter(cursor.measurements) },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: MEASUREMENT_SELECT,
      }),
      prisma.moodEntry.findMany({
        where: { userId, ...keysetFilter(cursor.mood) },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: MOOD_SELECT,
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, ...keysetFilter(cursor.intakes) },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
        select: INTAKE_SELECT,
      }),
      cycleEnabled
        ? prisma.cycleDayLog.findMany({
            where: { userId, ...keysetFilter(cursor.cycleDays) },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: limit + 1,
            include: dayLogSymptomInclude,
          })
        : [],
      cycleEnabled
        ? prisma.menstrualCycle.findMany({
            where: { userId, ...keysetFilter(cursor.cycles) },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            take: limit + 1,
          })
        : [],
      readMeasurementMirrorRows(userId, cursor.measurementMirror, limit),
    ]);
  return { measurements, mood, intakes, cycleDays, cycles, measurementMirror };
}
