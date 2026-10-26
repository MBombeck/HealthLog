/**
 * v1.7.0 — per-user metric/imperial display preference endpoint.
 *
 *  GET    /api/auth/me/unit-preference  — current preference.
 *  PATCH  /api/auth/me/unit-preference  — body
 *                                         `{ unitPreference: "metric" | "imperial" }`.
 *
 * Canonical storage stays SI on every measurement row; this only
 * selects which branch of the display-time transform registry the
 * client renders (km/h vs mph, km vs mi). Default "metric". The toggle
 * is reachable from Settings as a segmented control. Idempotent — the
 * endpoint always returns the resolved next state so the client can
 * hard-set the optimistic update without an extra round-trip.
 *
 * Mirrors the `disable-coach` per-user-scalar pattern: 60/min rate
 * limit, Zod safeParse → 422 via `returnAllZodIssues`, audit-log row,
 * field-by-field write (no mass assignment).
 *
 * The body goes through `safeJson` with a 1 KB cap, like the
 * `documents-auto-ai-read` scalar beside it. It used to read a bare
 * `request.json()`, which applied no size limit at all — the one endpoint in
 * this family that would materialise whatever it was sent — and answered a
 * malformed body with 422 where every sibling answers 400. Both were
 * accidents of the original copy, not a contract: the only caller checks
 * `res.ok` and never the status.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { DEFAULT_UNIT_PREFERENCE } from "@/lib/measurements/display-transform";
import { unitPreferencePatchSchema } from "@/lib/validations/user-prefs";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type UnitPreferenceResponse = {
  unitPreference: "metric" | "imperial";
};

function resolve(value: string | null | undefined): "metric" | "imperial" {
  return value === "imperial" ? "imperial" : DEFAULT_UNIT_PREFERENCE;
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.unit-preference.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { unitPreference: true },
  });
  const payload: UnitPreferenceResponse = {
    unitPreference: resolve(row?.unitPreference),
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `unit-preference:patch:${user.id}`,
    PATCH_RATE_LIMIT,
    PATCH_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // The body is a single enum value — bound the parse so a malformed or
  // oversized payload is rejected before it is materialised.
  const parsed = await parseJsonBody(req, unitPreferencePatchSchema, {
    maxBytes: 1024,
    action: "auth.me.unit-preference.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.unitPreference;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { unitPreference: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { unitPreference: next },
  });

  await auditLog("user.unit-preference.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: resolve(previous?.unitPreference),
      next,
    },
  });

  // The status notes and narratives quote mass, length and temperature in
  // this branch; re-warm them so today's stored text follows the switch.
  if (resolve(previous?.unitPreference) !== next) {
    void refreshTextsAfterUnitChange(user.id);
  }

  annotate({
    action: { name: "auth.me.unit-preference.patch" },
    meta: { unitPreference: next },
  });

  const payload: UnitPreferenceResponse = { unitPreference: next };
  return apiSuccess(payload);
});
