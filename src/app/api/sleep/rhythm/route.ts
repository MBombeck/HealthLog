/**
 * GET /api/sleep/rhythm
 *
 * v1.17.0 — server-authoritative sleep-rhythm read. Returns the two timing
 * signals the Sleep page + the iOS client render off the SAME canonical night
 * reconstruction the Sleep Score uses:
 *
 *   - `sleepDebt`   — outstanding balance over the rolling window (surplus
 *                     sleep pays it down), with a calm
 *                     `partial` state under the night threshold.
 *   - `chronotype`  — MCTQ MSF / MSFsc band + social jetlag, with a `learning`
 *                     state until enough free-day nights exist.
 *
 * The math lives in `sleep-debt.ts` / `chronotype.ts`; this route is the auth +
 * read boundary over `buildSleepRhythm`, which owns the DB read, the canonical
 * reconstruction, the age-based `needMinutes`, and the weekday/weekend day-type
 * default. No schema, no new type — a view over the existing per-stage
 * `SLEEP_DURATION` rows.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`). Soft-delete-filtered.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { buildSleepRhythm } from "@/lib/insights/derived/sleep-rhythm";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "measurements");

  // Per-domain gate: the sleep-rhythm read serves only the sleep module's
  // view surfaces (Sleep page + iOS), so it gates on the sleep module.
  // Disabled ⇒ 403 module.disabled.
  const gate = await requireModuleEnabled(user.id, "sleep");
  if (!gate.enabled) return gate.response;

  const rhythm = await buildSleepRhythm(user.id);

  annotate({
    action: { name: "sleep.rhythm" },
    meta: {
      debt_state: rhythm.sleepDebt.state,
      chronotype_state: rhythm.chronotype.state,
    },
  });

  return apiSuccess(rhythm);
});
