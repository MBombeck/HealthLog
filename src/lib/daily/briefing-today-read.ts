/**
 * The briefing as every surface serves it: the digest, the dashboard
 * snapshot and the `/insights` advisor payload all go through
 * `briefingForToday`, so a client never decides for itself whether
 * yesterday's text or a raw "+33.72 bpm" may be shown.
 *
 * The snapshot already carries each type's newest reading and passes it in;
 * the advisor route has no snapshot at hand and reads the few reading types
 * a signal can rest on here, in one grouped query, and only when the payload
 * actually carries such a signal.
 */
import { dailyBriefingSchema, type DailyBriefing } from "@/lib/ai/schema";
import { prisma } from "@/lib/db";
import type { Locale } from "@/lib/i18n/config";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { userDayKey } from "@/lib/tz/format";
import {
  SIGNAL_READING_TYPE,
  briefingForToday,
} from "@/lib/daily/briefing-today";
import type { MeasurementType } from "@/generated/prisma/client";

/** Whether a generation moment falls on today's calendar day in `timezone`. */
export function generatedOnLocalToday(
  generatedAt: string | null,
  timezone: string,
  now: Date,
): boolean {
  return (
    generatedAt !== null &&
    userDayKey(new Date(generatedAt), timezone) === userDayKey(now, timezone)
  );
}

/**
 * The newest reading of every type a briefing signal can rest on. A failed
 * read answers "no reading" for every type, which drops reading-backed
 * signals: the quiet side of the rule, never a stale claim.
 */
export async function readSignalLastSeen(
  userId: string,
): Promise<(type: string) => string | null> {
  try {
    const rows = await prisma.measurement.groupBy({
      by: ["type"],
      where: {
        userId,
        deletedAt: null,
        type: {
          in: Object.values(SIGNAL_READING_TYPE) as MeasurementType[],
        },
      },
      _max: { measuredAt: true },
    });
    const byType = new Map(
      rows.map((row) => [
        String(row.type),
        row._max.measuredAt?.toISOString() ?? null,
      ]),
    );
    return (type) => byType.get(type) ?? null;
  } catch {
    return () => null;
  }
}

/**
 * A cached advisor payload with its `dailyBriefing` resolved for today:
 * null when the text was generated on an earlier day (or at an unknown
 * time), otherwise without signals whose metric was not measured today and
 * with every delta at its metric's precision. Anything that is not an
 * advisor payload with a valid briefing passes through untouched.
 */
export async function insightsPayloadForToday(
  payload: unknown,
  ctx: { userId: string; timezone: string; language: Locale; now?: Date },
): Promise<unknown> {
  if (payload === null || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (record.dailyBriefing == null) return payload;
  const parsed = dailyBriefingSchema.safeParse(record.dailyBriefing);
  if (!parsed.success) return payload;
  const briefing: DailyBriefing = parsed.data;
  const now = ctx.now ?? new Date();
  const needsReadings = (briefing.signalsOfDay ?? []).some(
    (s) => SIGNAL_READING_TYPE[s.sourceMetric] !== undefined,
  );
  const lastSeenAt = needsReadings
    ? await readSignalLastSeen(ctx.userId)
    : () => null;
  return {
    ...record,
    dailyBriefing: briefingForToday(briefing, {
      generatedAt: readBriefingGeneratedAt(record),
      lastSeenAt,
      timezone: ctx.timezone,
      todayLocalDate: userDayKey(now, ctx.timezone),
      language: ctx.language,
    }),
  };
}
