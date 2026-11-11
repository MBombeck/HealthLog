/**
 * v1.25 — health-status / baseline-drift read.
 *
 *   GET /api/insights/health-status
 *
 * Surfaces what is drifting from the user's own normal, drawn off two existing
 * read-only engines — the personal-band deviations from the coincident-
 * deviation flag (`coincident-deviation.ts`) and the dated, sustained level
 * shifts from the changepoint detector (`changepoint.ts`). Pure compute over
 * the rollup tier: no provider call, no fabricated value, never a diagnosis.
 *
 * Mirrors `/api/insights/derived`: `apiHandler` wrapper, `requireAuth`, the
 * shared analytics-read budget. No module gate: the drift read spans every
 * vital, and the `insights` module is the AI analysis opt-out, which a
 * computation does not depend on. `userId` is always
 * narrowed from the session. The labels are mapped client-side from the
 * MeasurementType, so the wire carries the type tokens only.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { loadBaselineProfile } from "@/lib/insights/derived";
import { computeCoincidentDeviation } from "@/lib/insights/derived/coincident-deviation";
import { buildExtendedChangepointSignals } from "@/lib/insights/derived/changepoint";
import { MODULE_KEYS, resolveModuleMap } from "@/lib/modules/gate";
import { summariseHealthStatus } from "@/lib/insights/health-status";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  // Both engines walk every vital over up to 180 days, so the answer goes
  // through the analytics cell its sibling reads use. Measurement and mood
  // writes sweep the record's cells; the reader's day and the switched-off
  // modules are part of the key, so a new day or a module switch never serves
  // the other answer.
  const modules = await resolveModuleMap(user.id);
  const modulesOff = MODULE_KEYS.filter((key) => modules[key] === false);
  const now = new Date();
  const day = userDayKey(now, user.timezone ?? DEFAULT_TIMEZONE);
  const body = await cachedSwr(
    caches.analytics as ServerCache<HealthStatusBody>,
    `${user.id}|health-status|${day}|off:${modulesOff.join(",")}`,
    () => buildHealthStatus(user.id, user.timezone, now, modules),
    annotate,
  );

  annotate({
    action: { name: "insights.health-status.read" },
    meta: {
      deviations: body.deviations.length,
      shifts: body.shifts.length,
    },
  });

  return apiSuccess(body);
});

type HealthStatusBody = Awaited<ReturnType<typeof buildHealthStatus>>;

async function buildHealthStatus(
  userId: string,
  timezone: string | undefined,
  now: Date,
  modules: Awaited<ReturnType<typeof resolveModuleMap>>,
) {
  const profile = await loadBaselineProfile(prisma, userId);
  const coincident = await computeCoincidentDeviation(userId, profile, {
    tz: timezone,
    now,
  });
  // v1.44 — the wider scan: every vital with a stable daily level over 180
  // days, a metric whose module is off left unread.
  const shifts = await buildExtendedChangepointSignals(userId, now, modules);

  const vitals = coincident.status === "ok" ? coincident.value.vitals : [];
  const summary = summariseHealthStatus(vitals, shifts);
  return {
    present: summary.present,
    deviations: summary.deviations,
    shifts: summary.shifts,
    generatedAt: now.toISOString(),
  };
}
