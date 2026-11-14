import { NextRequest } from "next/server";

import {
  apiHandler,
  isScopedCredential,
  requireAuth,
  requireRecordAuth,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import { serialiseCustomMetricEntry } from "@/lib/custom-metrics/custom-metric-store";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import {
  createCustomMetricEntrySchema,
  listCustomMetricEntriesSchema,
} from "@/lib/validations/custom-metrics";

/**
 * v1.25.5 — logged values for one custom metric
 * (`/api/custom-metrics/{id}/entries`).
 *
 * GET lists the metric's values with offset pagination (the chart + history
 * feed). POST records a value, snapshotting the metric's current `unit` onto
 * the entry at write time (historical truth). `userId` is always narrowed from
 * the session (or, on POST, the measurement-ingest token) and the parent metric
 * is verified owner-scoped (a forged / foreign id is a 404) before any value is
 * read or written.
 */

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "measurements");
    const { id } = await params;

    const metric = await prisma.customMetric.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!metric) {
      return apiError("Custom metric not found", 404);
    }

    const query = Object.fromEntries(request.nextUrl.searchParams);
    const parsed = listCustomMetricEntriesSchema.safeParse(query);
    if (!parsed.success) {
      annotate({
        action: { name: "custom-metric.entry.list.validation-failed" },
        meta: { issue_count: parsed.error.issues.length },
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const { limit, offset, sortDir } = parsed.data;
    const where = { userId: user.id, customMetricId: id, deletedAt: null };

    const [rows, total] = await Promise.all([
      prisma.customMetricEntry.findMany({
        where,
        // Unique tiebreaker — see the measurements list: offset paging over
        // a non-unique sort key can repeat and drop rows between pages.
        orderBy: [{ measuredAt: sortDir }, { id: sortDir }],
        take: limit,
        skip: offset,
      }),
      prisma.customMetricEntry.count({ where }),
    ]);

    annotate({
      action: { name: "custom-metric.entry.list" },
      meta: { customMetricId: id, total, limit, offset },
    });

    return apiSuccess({
      entries: rows.map(serialiseCustomMetricEntry),
      meta: { total, limit, offset },
    });
  },
);

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postCustomMetricEntry),
);

async function postCustomMetricEntry(
  request: NextRequest,
  { params }: RouteParams,
) {
  // v1.36.x — NOT a delegated write, and it was one for a release. It left
  // the admitted set for the reason `POST /api/allergies` and
  // `POST /api/family-history` left it in the same release: no delegate can
  // reach a surface that posts here. The only one is the entry form on
  // `/custom-metrics/{id}`, and that route is not a shared-record destination,
  // so the shell turns a delegate away before the form mounts — the rule was
  // applied to two of the three siblings and this one was missed.
  //
  // A permission with no caller is a permission frozen ahead of the surface
  // that would exercise it, and the consent screen was naming a capability the
  // product did not offer. Whoever builds a delegate-reachable way to log a
  // tracked value adds it back in the same diff: the argument for admitting it
  // was never wrong, and the GET arm above stays delegable meanwhile.
  //
  // It does accept the measurement-ingest token (#1377): a custom metric's
  // value is a reading the person defined themselves, and the bridge that
  // pushes their weight is the one that would push it. What that admits is
  // this POST and nothing beside it. The GET above names no scope, nor do the
  // metric's own create / edit / delete routes, so the token can add a value
  // to a metric that already exists and cannot list the metrics, read one
  // back, or make a new one. The id it writes to comes from the person, who
  // reads it off the metric's page; a token that has only ever been pasted
  // into a scale's uploader never learns one.
  //
  // `requireAuth` rather than the record resolver, so the selector refusal is
  // the undeclared-mode one every credential meets here: the token is on its
  // owner's record or nowhere. The ownership query below then turns any id
  // that is not that owner's live metric into the same 404 an unknown id gets.
  const auth = await requireAuth(MEASUREMENTS_WRITE_SCOPE);
  const { user } = auth;
  // A custom-metric entry has no source column, so the row cannot say a
  // bridge wrote it the way an `EXTERNAL` measurement does. The audit row
  // can, and it names the token, so revoking the right one is possible later.
  const ingestTokenId = isScopedCredential(auth) ? auth.session.id : null;

  const { id } = await params;

  const metric = await prisma.customMetric.findFirst({
    where: { id, userId: user.id, deletedAt: null },
    select: { id: true, unit: true },
  });
  if (!metric) {
    return apiError("Custom metric not found", 404);
  }

  const parsed = await parseJsonBody(request, createCustomMetricEntrySchema, {
    maxBytes: 16 * 1024,
    action: "custom-metric.entry.create.validation-failed",
    countIssues: true,
    meta: { customMetricId: id },
    onInvalid: (error) => {
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.36.x — through `auditLog()`, the only writer that stamps the actor.
      void auditLog("custom-metric.entry.create.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues, customMetricId: id },
      }).catch(() => {
        /* swallow — the 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

  const { value, measuredAt, note } = parsed.data;

  // Field-by-field assignment — never spread `parsed.data`. The metric's
  // current unit is snapshotted onto the entry as historical truth.
  const created = await prisma.customMetricEntry.create({
    data: {
      userId: user.id,
      customMetricId: metric.id,
      value,
      unit: metric.unit,
      measuredAt,
      // v1.39.3 — the note is stored encrypted; the readable column stays NULL.
      noteEncrypted: encryptNote(note),
    },
  });

  await auditLog("customMetricEntry.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      customMetricId: id,
      entryId: created.id,
      ...(ingestTokenId ? { ingestTokenId } : {}),
    },
  });

  annotate({
    action: { name: "custom-metric.entry.create" },
    meta: {
      customMetricId: id,
      entryId: created.id,
      via_ingest_scope: ingestTokenId !== null,
    },
  });
  invalidateUserCorrelationPatterns(user.id);

  return apiSuccess(serialiseCustomMetricEntry(created), 201);
}
