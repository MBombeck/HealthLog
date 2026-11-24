/**
 * GET /api/sleep/night?date=YYYY-MM-DD
 *
 * v1.11.5 — read-only hypnogram source. Returns ONE night's reconstructed
 * sleep session: the canonical source's stage SEGMENTS (each with an
 * absolute start / end), the per-stage breakdown, the asleep / in-bed /
 * awake totals, the mid-sleep awakenings count, and the same-wake-day naps
 * surfaced separately (the nap convention).
 *
 * The night is the canonical per-night reconstruction — session-clustered,
 * keyed by the LOCAL WAKE DAY, collapsed to one source via the user's sleep
 * priority ladder — so two sources' timelines never overlay. A view over the
 * existing per-stage `SLEEP_DURATION` rows; no schema, no new type.
 *
 * `reconstructed` (per session) is true when the winning source has no
 * per-stage onset timestamps and the server synthesised a contiguous timeline
 * (WHOOP) — the client renders the hypnogram but labels it an approximate
 * layout. A real-series source (Apple Health / Withings / Fitbit) is false.
 *
 * `date` omitted → the most recent night with a main sleep, however old; a
 * run of nap-only days since is stepped over (each stays reachable by its
 * `date`). An account that has only ever napped gets its latest nap day.
 *
 * Only the stage rows within a day and a half of the night are read, as the
 * list's drill-down reads them (`readNightSessions`), so any past night is
 * answered and a long history never reaches the heap.
 *
 * `overlays` (#1419) carries the night metrics the timeline can draw as lines
 * over the stages: pulse, HRV, breathing rate, SpO2, skin and room
 * temperature, each a series bucketed over the session or one value a night,
 * from one source per metric (`sleep/night-overlays.ts`). It is null when
 * there is no main night, and on a night of stage totals, which has no
 * timeline to lay a line on.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`). Soft-delete-filtered.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  pickMainNightAndNaps,
  type SleepSession,
} from "@/lib/analytics/sleep-night";
import {
  latestMainSleepNight,
  readNightSessions,
} from "@/lib/measurements/list/sleep-nights";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { isCalendarDateKey } from "@/lib/tz/date-only";
import {
  readNightOverlays,
  visibleOverlayTypes,
} from "@/lib/sleep/night-overlays";

const querySchema = z.object({
  // Optional wake-day key; when omitted the latest night is returned.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .refine(isCalendarDateKey, "date must be a real calendar date (YYYY-MM-DD)")
    .optional(),
});

function serializeSession(s: SleepSession) {
  return {
    night: s.night,
    // iOS #181 — the zone the night is read in when its rows carry one
    // that is not the profile zone (a night slept abroad); null otherwise.
    timeZone: s.timeZone,
    source: s.source,
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    // iOS #18 — round to whole minutes; the underlying totals are summed from
    // second-precision segments and otherwise serialise as e.g. 433.4999.
    // `inBedMinutes` / `awakeMinutes` stay null when the night never saw that
    // stage — rounding only the present values.
    asleepMinutes: Math.round(s.asleepMinutes),
    inBedMinutes: s.inBedMinutes === null ? null : Math.round(s.inBedMinutes),
    awakeMinutes: s.awakeMinutes === null ? null : Math.round(s.awakeMinutes),
    awakenings: s.awakenings,
    // iOS #18 — `reconstructed` is true when the source has no per-stage onset
    // timestamps and the server synthesised a contiguous timeline (WHOOP). iOS
    // labels the hypnogram as an approximate layout; it never recomputes.
    reconstructed: s.reconstructed,
    // iOS #18 — round the per-stage map too; the underlying totals sum
    // second-precision segments and otherwise serialise as e.g. 88.4999.
    stages: Object.fromEntries(
      Object.entries(s.stages).map(([stage, minutes]) => [
        stage,
        Math.round(minutes),
      ]),
    ),
    segments: s.segments.map((seg) => ({
      stage: seg.stage,
      start: seg.start.toISOString(),
      end: seg.end.toISOString(),
      minutes: Math.round(seg.minutes),
    })),
    // Additive, observational: two writer buckets reported clearly
    // different asleep totals for this session. Never changes the served
    // totals above — the UI only marks the number with a discreet hint.
    sourceDiscrepancy: s.sourceDiscrepancy
      ? {
          deltaMinutes: Math.round(s.sourceDiscrepancy.deltaMinutes),
          sources: s.sourceDiscrepancy.sources.map((b) => ({
            source: b.source,
            deviceType: b.deviceType,
            asleepMinutes: Math.round(b.asleepMinutes),
          })),
        }
      : null,
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  // Per-domain gate: the hypnogram read serves only the sleep module's
  // view surfaces, so it gates on the sleep module. Disabled ⇒ 403.
  const gate = await requireModuleEnabled(user.id, "sleep");
  if (!gate.enabled) return gate.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "sleep.night.validation-failed" },
      meta: { issue_count: issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { date } = parsed.data;
  const [tz, priorityJson] = await Promise.all([
    resolveUserTimezone(user.id),
    loadUserSourcePriority(user.id),
  ]);

  const targetDay =
    date ??
    (await latestMainSleepNight(user.id, tz, priorityJson)) ??
    undefined;
  const { main, naps } = targetDay
    ? pickMainNightAndNaps(
        (await readNightSessions(user.id, targetDay, tz, priorityJson))
          .sessions,
      )
    : { main: null, naps: [] };

  const overlays =
    main && !main.reconstructed
      ? await readNightOverlays({
          userId: user.id,
          session: { ...main, timeZone: main.timeZone ?? tz },
          priorityJson,
          visibleTypes: await visibleOverlayTypes(user.id),
        })
      : null;

  annotate({
    action: { name: "sleep.night" },
    meta: {
      night: targetDay ?? null,
      has_main: main != null,
      nap_count: naps.length,
      overlay_kinds: overlays?.metrics.map((m) => m.kind).join(",") ?? null,
    },
  });

  // A day of naps alone answers with its naps and no main night.
  return apiSuccess({
    night: targetDay ?? null,
    main: main ? serializeSession(main) : null,
    naps: naps.map(serializeSession),
    overlays,
  });
});
