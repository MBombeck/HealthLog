/**
 * Per-user blood-glucose display unit.
 *
 *  GET    /api/auth/me/glucose-unit  — current unit.
 *  PATCH  /api/auth/me/glucose-unit  — body
 *                                      `{ glucoseUnit: "mg/dL" | "mmol/L" }`.
 *
 * The column has existed since v1.2 and roughly thirty surfaces read it —
 * the dashboard tiles, the glucose insight page, the targets panel, the CSV
 * and FHIR exports, the doctor report, the Coach snapshot, the safety-floor
 * push copy. None of it was reachable, because nothing could ever write the
 * column: every account was NULL, and NULL resolves to mg/dL. For anyone in
 * a country that reads glucose in mmol/L that was the wrong number on every
 * screen. This is the missing end.
 *
 * Canonical storage stays mg/dL on every row and every ingest path. The unit
 * selects a display branch, exactly like `unit-preference` next door; the
 * entry form inverts through `toCanonicalMgdl` so a value TYPED in mmol/L
 * still persists as mg/dL. Nothing already stored is reinterpreted.
 *
 * Mirrors the `unit-preference` per-user-scalar pattern: 60/min rate limit,
 * `safeJson` with a 1 KB cap, Zod safeParse → 422 via `returnAllZodIssues`,
 * audit-log row, field-by-field write. Idempotent — the endpoint always
 * returns the resolved next state so the client can hard-set the optimistic
 * update without an extra round-trip.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { resolveGlucoseUnit, type GlucoseUnit } from "@/lib/glucose";
import { glucoseUnitPatchSchema } from "@/lib/validations/user-prefs";
import { refreshTextsAfterUnitChange } from "@/lib/insights/unit-change-refresh";

export const dynamic = "force-dynamic";

const PATCH_RATE_LIMIT = 60;
const PATCH_WINDOW_MS = 60_000;

type GlucoseUnitResponse = {
  glucoseUnit: GlucoseUnit;
};

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.glucose-unit.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { glucoseUnit: true },
  });
  const payload: GlucoseUnitResponse = {
    glucoseUnit: resolveGlucoseUnit(row?.glucoseUnit),
  };
  return apiSuccess(payload);
});

export const PATCH = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `glucose-unit:patch:${user.id}`,
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
  const parsed = await parseJsonBody(req, glucoseUnitPatchSchema, {
    maxBytes: 1024,
    action: "auth.me.glucose-unit.patch.invalid_shape",
  });
  if (!parsed.ok) return parsed.error;

  const next = parsed.data.glucoseUnit;

  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { glucoseUnit: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { glucoseUnit: next },
  });

  await auditLog("user.glucose-unit.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: resolveGlucoseUnit(previous?.glucoseUnit),
      next,
    },
  });

  // The status notes and narratives quote glucose in this unit; re-warm
  // them so today's stored text does not keep the old one.
  if (resolveGlucoseUnit(previous?.glucoseUnit) !== next) {
    void refreshTextsAfterUnitChange(user.id);
  }

  annotate({
    action: { name: "auth.me.glucose-unit.patch" },
    meta: { glucoseUnit: next },
  });

  const payload: GlucoseUnitResponse = { glucoseUnit: next };
  return apiSuccess(payload);
});
