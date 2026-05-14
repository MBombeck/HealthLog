/**
 * v1.4.25 W6c — per-user Doctor-Report section toggles.
 *
 *  GET  /api/auth/me/doctor-report-prefs  — returns the resolved prefs
 *                                           (defaults when the row is null).
 *  PUT  /api/auth/me/doctor-report-prefs  — merges the supplied partial
 *                                           shape over the current row
 *                                           and persists the canonical
 *                                           fully-resolved object so a
 *                                           future schema migration
 *                                           doesn't need to back-fill
 *                                           missing keys.
 *
 * Bearer-auth + cookie-auth both work via the shared `requireAuth()`
 * helper. The doctor-report aggregator + PDF renderer both read this
 * row at generation time so mood data is dropped at the aggregator
 * layer when `mood = false` — the data never leaves the DB.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  doctorReportPrefsSchema,
  parseDoctorReportPrefs,
  resolveDoctorReportPrefs,
} from "@/lib/validations/doctor-report-prefs";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.doctor-report-prefs.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { doctorReportPrefsJson: true },
  });
  return apiSuccess(parseDoctorReportPrefs(row?.doctorReportPrefsJson));
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "doctor-report-prefs.body.invalid_json");
  }

  const parsed = doctorReportPrefsSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.doctor-report-prefs.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    throw new HttpError(422, "doctor-report-prefs.body.invalid_shape");
  }

  // Merge the partial input over the current row (or defaults) so a
  // dialog that only toggles `mood` doesn't have to re-state every other
  // flag. Persist the canonical fully-resolved object so the column
  // shape stays stable across future schema additions.
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { doctorReportPrefsJson: true },
  });
  const merged = resolveDoctorReportPrefs(
    current?.doctorReportPrefsJson,
    parsed.data,
  );

  await prisma.user.update({
    where: { id: user.id },
    // `merged` is a typed object; Prisma's `InputJsonValue` insists on an
    // index signature so cast through `unknown` rather than widen the
    // typed return surface. Shape is identical to the validated input.
    data: {
      doctorReportPrefsJson: merged as unknown as Record<string, boolean>,
    },
  });

  // v1.4.25 W10 reconcile (security M-3): record the previous + new
  // pref shape in the audit log. Doctor-Report pref toggles
  // (especially `mood: true`) widen the PDF surface; without an
  // audit trail a silent compromise (or unintended client write)
  // is invisible. Mirrors the timezone-route audit pattern.
  await auditLog("user.doctor-report-prefs.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: current?.doctorReportPrefsJson ?? null,
      next: merged,
    },
  });

  annotate({
    action: { name: "auth.me.doctor-report-prefs.put" },
    meta: {
      bp: merged.bp,
      weight: merged.weight,
      pulse: merged.pulse,
      bmi: merged.bmi,
      mood: merged.mood,
      compliance: merged.compliance,
      sleep: merged.sleep,
    },
  });
  return apiSuccess(merged);
});
