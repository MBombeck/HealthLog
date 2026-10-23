/**
 * GET / PUT / DELETE medications list presentation.
 *
 * GET returns the resolved presentation (view + manual order, defaults
 * merged in if the user hasn't customised yet). PUT updates it with
 * preserve-when-absent semantics — a view-only PUT keeps the stored
 * order and vice versa, matching the `chartOverlayPrefs` contract on
 * `/api/dashboard/widgets`. DELETE resets to default.
 *
 * Mirrors the shape and semantics of `/api/insights/layout`; the blob
 * lives on its own `User` column (`medication_list_layout_json`) per
 * the per-surface-column convention.
 */
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  safeJson,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  resolveMedicationListLayout,
  serializeMedicationListLayout,
  DEFAULT_MEDICATION_LIST_LAYOUT,
  MEDICATION_LIST_VIEWS,
  MEDICATION_ORDER_ID_MAX_LENGTH,
  MEDICATION_ORDER_MAX_ENTRIES,
  type MedicationListLayoutWithToken,
} from "@/lib/medication-list-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserMedicationListLayout } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";
import type { NextRequest } from "next/server";

const layoutSchema = z.object({
  version: z.literal(1),
  // Both fields are optional so a client can PUT exactly the field it
  // changed; the handler merges the absent one from the stored blob
  // (preserve-when-absent, like `chartOverlayPrefs` on the dashboard layout).
  view: z.enum(MEDICATION_LIST_VIEWS).optional(),
  // Medication ids are opaque here — display-only ordering, unknown /
  // deleted ids are ignored at apply time, so the schema bounds size
  // and shape but does not assert ownership.
  order: z
    .array(z.string().min(1).max(MEDICATION_ORDER_ID_MAX_LENGTH))
    .max(MEDICATION_ORDER_MAX_ENTRIES)
    .optional(),
});

async function buildMedicationListLayout(
  userId: string,
): Promise<MedicationListLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // v1.32.21 — `updatedAt` rides the cached blob so GET hands the
    // client the optimistic-concurrency token alongside the presentation it
    // applies to (busted on every write, so the pair stays consistent).
    select: { medicationListLayoutJson: true, updatedAt: true },
  });
  return {
    ...resolveMedicationListLayout(row?.medicationListLayoutJson),
    updatedAt: row?.updatedAt?.toISOString(),
  };
}

export const GET = apiHandler(async () => {
  // Read: the RECORD's presentation. Write: refused — see the PUT and DELETE.
  //
  // Same split as `/api/dashboard/widgets`, and here the read half decides
  // itself: `order` is a list of MEDICATION IDS, and unknown ids are dropped
  // at apply time. The caller's own order names the caller's own medications,
  // so serving it against the owner's cabinet would resolve to nothing and the
  // owner's list would fall back to default order — a preference that cannot
  // apply is not a preference, it is noise. `/medications` is a shared
  // destination, so this is a list a delegate really does see.
  const { user } = await requireRecordAuth("read", "medications");

  // 5-minute TTL matches the dashboard-widgets / insights-layout caches; the
  // blob changes only on a view toggle or an order save, which invalidates via
  // `invalidateUserMedicationListLayout()`. Keyed on the resolved id, so a
  // delegated read fills the owner's cell and never their own.
  const layout = await cached(
    caches.medicationListLayout as ServerCache<MedicationListLayoutWithToken>,
    user.id,
    () => buildMedicationListLayout(user.id),
    annotate,
  );
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  // Bare on purpose, so it refuses under a switch while the GET does not. The
  // reorder handle sits on `/medications`, which IS a shared destination, so
  // this is the one refusal on the front-door set a delegate can actually walk
  // into — and it is the correct one: the stored order is what the OWNER sees
  // on their own next visit, and a helper tidying somebody else's cabinet into
  // their preferred sequence is a change the owner never asked for and would
  // have to undo by hand.
  const { user } = await requireAuth();

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.21 — pull the optimistic-concurrency base token off the body
  // BEFORE the Zod parse so the domain schema stays pure (issue #581 family).
  // BOTH writers (view toggle, order save) route through here, so the token
  // guards either against a stale interleave of the other.
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;
  const body = taken.rest;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    // Multi-issue 422 envelope matches the dashboard-widgets / insights
    // layout routes; the wide-event line carries the redacted payload
    // shape for operator debugging without leaking the raw body.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const payloadDiagnostic = buildPayloadDiagnostic(redactForExcerpt(body));
    annotate({
      action: { name: "medication.layout.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    if (
      shouldEmitAuditRow(
        user.id,
        "medication.layout.validation-failed",
        Date.now(),
      )
    ) {
      // Best-effort breadcrumb — never block the 422 on a write miss.
      // `message` strips from the audit row so a Zod code that embeds
      // the offending value cannot leak through the audit surface.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      auditLog("medication.layout.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — validation response is the contract, audit row is best-effort */
      });
    }
    return returnAllZodIssues(parsed.error, 422);
  }

  // Preserve-when-absent: a PUT carrying only `view` must not wipe the
  // stored manual order, and an order-only PUT must not reset the view.
  // One stored-blob read covers both fallbacks.
  let mergedView = parsed.data.view;
  let mergedOrder = parsed.data.order;
  if (mergedView === undefined || mergedOrder === undefined) {
    const existing = await buildMedicationListLayout(user.id);
    if (mergedView === undefined) mergedView = existing.view;
    if (mergedOrder === undefined) mergedOrder = existing.order;
  }
  const normalized = serializeMedicationListLayout({
    view: mergedView,
    order: mergedOrder,
  });

  // v1.32.21 — guard the write on the client's base token. A stale base
  // 409s and writes NOTHING, so a view toggle can't resurrect an order the
  // reorder Save just committed (or vice versa); a tokenless request keeps the
  // prior unconditional write.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { medicationListLayoutJson: toJson(normalized) },
    conflict: {
      action: "medication.layout.conflict",
      errorCode: "medication_layout_conflict",
      message: "Medications layout changed since it was loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  annotate({
    action: { name: "medication.layout.update" },
    meta: { view: normalized.view, order_count: normalized.order.length },
  });

  invalidateUserMedicationListLayout(user.id);

  return apiSuccess({
    ...normalized,
    updatedAt: guarded.updatedAt,
  } satisfies MedicationListLayoutWithToken);
});

export const DELETE = apiHandler(async () => {
  // Bare, for the reason on the PUT: wiping somebody else's stored order is
  // the same edit with a bigger blast radius.
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { medicationListLayoutJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "medication.layout.reset" } });

  invalidateUserMedicationListLayout(user.id);

  return apiSuccess(DEFAULT_MEDICATION_LIST_LAYOUT);
});
