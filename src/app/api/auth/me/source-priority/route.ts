/**
 * v1.4.25 W5e — per-user, per-metric-class source priority.
 *
 *  GET  /api/auth/me/source-priority  — returns the fully-defaulted
 *                                       shape (missing keys filled
 *                                       from `DEFAULT_SOURCE_PRIORITY`).
 *  PUT  /api/auth/me/source-priority  — replaces the persisted shape;
 *                                       body is validated against
 *                                       `sourcePrioritySchema` and
 *                                       persisted as the partial form
 *                                       (missing keys keep the default
 *                                       at read time).
 *
 * Bearer-auth + cookie-auth both work via the shared `requireAuth()`
 * helper. The analytics aggregator reads this row on every call and
 * the read path is cheap (one column). The PUT flushes the per-user
 * profile-derived caches (`invalidateUserProfile`) because the ladder
 * decides which source's rows the cached targets / derived / analytics
 * payloads were built from.
 */
import { apiHandler, requireAuth, HttpError } from "@/lib/api-handler";
import {
  apiSuccess,
  apiValidationError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { invalidateUserProfile } from "@/lib/cache/invalidate";
import {
  parseSourcePriority,
  sourcePrioritySchema,
} from "@/lib/validations/source-priority";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.source-priority.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true },
  });
  return apiSuccess(parseSourcePriority(row?.sourcePriorityJson));
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(422, "source-priority.body.invalid_json");
  }

  const parsed = sourcePrioritySchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.source-priority.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    // The dotted token keeps its place in `error` — clients already match on it
    // there — while `meta.errorCode` publishes it in the field a machine code
    // belongs in, and `details.issues` names the fields that were refused.
    return apiValidationError(
      "source-priority.body.invalid_shape",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "source-priority.body.invalid_shape" },
    );
  }

  // v1.4.25 W10 reconcile (security M-3): capture the previous shape
  // before overwriting so the audit-log entry records the actual
  // delta. Source-priority drives every aggregator's source pick,
  // so a silent compromise (or accidental client write) was
  // previously invisible — mirroring the timezone-route audit
  // pattern closes the gap.
  const before = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true },
  });

  // Persist the partial form — missing keys read as defaults via
  // `parseSourcePriority`. Storing only the user-edited subset keeps
  // the Json blob narrow and future-proofs the shape: when a new
  // metric class is added, every existing row reads the new key's
  // default until the user explicitly changes it.
  await prisma.user.update({
    where: { id: user.id },
    data: { sourcePriorityJson: parsed.data },
  });

  // The priority ladder drives every aggregator's source pick (the
  // analytics rank SQL, the rollup read-swap, the targets grid's sleep
  // dedup) — drop the cached payloads so the reorder reflects on the
  // next read instead of after the TTL.
  invalidateUserProfile(user.id);

  await auditLog("user.source-priority.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: before?.sourcePriorityJson ?? null,
      next: parsed.data,
    },
  });

  annotate({
    action: { name: "auth.me.source-priority.put" },
    meta: { keys: Object.keys(parsed.data).length },
  });
  return apiSuccess(parseSourcePriority(parsed.data));
});
