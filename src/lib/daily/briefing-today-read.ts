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
import type { DailyBriefing } from "@/lib/ai/schema";
import { readDailyBriefing } from "@/lib/ai/briefing-blocks";
import { prisma } from "@/lib/db";
import { readLatestEver } from "@/lib/dashboard/summary-reads";
import type { Locale } from "@/lib/i18n/config";
import { readBriefingGeneratedAt } from "@/lib/insights/briefing-generated-at";
import { userDayKey } from "@/lib/tz/format";
import {
  ALL_SIGNAL_READING_TYPES,
  SIGNAL_READING_TYPE,
  briefingForToday,
} from "@/lib/daily/briefing-today";
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * The newest reading of every type a briefing signal can rest on. A failed
 * read answers "no reading" for every type, which drops reading-backed
 * signals: the quiet side of the rule, never a stale claim.
 */
export async function readSignalLastSeen(
  userId: string,
): Promise<(type: string) => string | null> {
  try {
    // One index probe per type for its latest live reading
    // (`readLatestEver`), rather than a grouped max over every row.
    const rows = await readLatestEver(
      prisma,
      userId,
      ALL_SIGNAL_READING_TYPES as MeasurementType[],
    );
    const byType = new Map(
      rows.map((row) => [
        String(row.type),
        new Date(row.measured_at).toISOString(),
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
  const read = readDailyBriefing(record.dailyBriefing);
  if (read.state !== "valid") return payload;
  const briefing: DailyBriefing = read.briefing;
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
