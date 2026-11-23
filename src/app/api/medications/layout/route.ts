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
  guardedUserDocumentUpdate,
  invalidBaseTokenError,
  readUserDocumentToken,
  userDocumentToken,
} from "@/lib/optimistic-lock";
import {
  resolveMedicationListLayout,
  serializeMedicationListLayout,
  DEFAULT_MEDICATION_LIST_LAYOUT,
  MEDICATION_LIST_VIEWS,
  MEDICATION_GROUP_BYS,
  MEDICATION_GROUPS_OPEN,
  MEDICATION_ORDER_ID_MAX_LENGTH,
  MEDICATION_ORDER_MAX_ENTRIES,
  type MedicationListLayoutWithToken,
} from "@/lib/medication-list-layout";
import { Prisma } from "@/generated/prisma/client";
import {
  isCustomMedicationCategoryKey,
  medicationCategoryOrderSchema,
} from "@/lib/validations/medication/base";
import { z } from "zod/v4";
import { invalidateUserMedicationListLayout } from "@/lib/cache/invalidate";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { cachedAtRevision } from "@/lib/cache/cached-at-revision";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";
import type { NextRequest } from "next/server";

const layoutSchema = z.object({
  version: z.literal(1),
  // Fields are optional so a client can PUT exactly the field it
  // changed; the handler merges the absent ones from the stored blob
  // (preserve-when-absent, like `chartOverlayPrefs` on the dashboard layout).
  view: z.enum(MEDICATION_LIST_VIEWS).optional(),
  // Medication ids are opaque here — display-only ordering, unknown /
  // deleted ids are ignored at apply time, so the schema bounds size
  // and shape but does not assert ownership.
  order: z
    .array(z.string().min(1).max(MEDICATION_ORDER_ID_MAX_LENGTH))
    .max(MEDICATION_ORDER_MAX_ENTRIES)
    .optional(),
  groupBy: z.enum(MEDICATION_GROUP_BYS).optional(),
  groupsOpen: z.enum(MEDICATION_GROUPS_OPEN).optional(),
  // Built-in values or `custom:<uuid>` keys, nothing else: a malformed key
  // is a 422. A well-formed custom key the account does not have (deleted,
  // or another account's) is dropped below rather than refused, because a
  // client's draft can name a category deleted on another device meanwhile.
  categoryOrder: medicationCategoryOrderSchema.optional(),
});

/**
 * The category order as written: built-in values, and only the custom keys
 * this account has (hidden ones included, they still file medications).
 */
async function keepOwnCategoryKeys(
  userId: string,
  order: readonly string[],
): Promise<string[]> {
  const custom = order.filter(isCustomMedicationCategoryKey);
  if (custom.length === 0) return [...order];
  const owned = new Set(
    (
      await prisma.medicationCategoryLabel.findMany({
        where: { userId, key: { in: custom } },
        select: { key: true },
      })
    ).map((row) => row.key),
  );
  return order.filter(
    (key) => !isCustomMedicationCategoryKey(key) || owned.has(key),
  );
}

async function buildMedicationListLayout(
  userId: string,
): Promise<MedicationListLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // The lock token rides with the presentation it applies to: the
    // document's own revision, never the row's `updatedAt`.
    select: {
      medicationListLayoutJson: true,
      medicationListLayoutRevisedAt: true,
    },
  });
  return {
    ...resolveMedicationListLayout(row?.medicationListLayoutJson),
    updatedAt: userDocumentToken(row, "medicationListLayout"),
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

  // 5-minute TTL matches the dashboard-widgets / insights-layout caches.
  // The cell is served only while its token is the document's current
  // revision, so a writer that forgot to invalidate can never hand out a
  // stale token. Keyed on the resolved id, so a delegated read fills the
  // owner's cell and never their own.
  const layout = await cachedAtRevision(
    caches.medicationListLayout as ServerCache<MedicationListLayoutWithToken>,
    user.id,
    await readUserDocumentToken(user.id, "medicationListLayout"),
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

  // Preserve-when-absent: a PUT carrying a subset of fields must not wipe the
  // stored values for omitted fields.
  // One stored-blob read covers all fallbacks.
  let mergedView = parsed.data.view;
  let mergedOrder = parsed.data.order;
  let mergedGroupBy = parsed.data.groupBy;
  let mergedGroupsOpen = parsed.data.groupsOpen;
  let mergedCategoryOrder =
    parsed.data.categoryOrder === undefined
      ? undefined
      : await keepOwnCategoryKeys(user.id, parsed.data.categoryOrder);
  if (
    mergedView === undefined ||
    mergedOrder === undefined ||
    mergedGroupBy === undefined ||
    mergedGroupsOpen === undefined ||
    mergedCategoryOrder === undefined
  ) {
    const existing = await buildMedicationListLayout(user.id);
    if (mergedView === undefined) mergedView = existing.view;
    if (mergedOrder === undefined) mergedOrder = existing.order;
    if (mergedGroupBy === undefined) mergedGroupBy = existing.groupBy;
    if (mergedGroupsOpen === undefined) mergedGroupsOpen = existing.groupsOpen;
    if (mergedCategoryOrder === undefined)
      mergedCategoryOrder = existing.categoryOrder;
  }
  const normalized = serializeMedicationListLayout({
    view: mergedView,
    order: mergedOrder,
    groupBy: mergedGroupBy,
    groupsOpen: mergedGroupsOpen,
    categoryOrder: mergedCategoryOrder,
  });

  // v1.32.21 — guard the write on the client's base token. A stale base
  // 409s and writes NOTHING, so a view toggle can't resurrect an order the
  // reorder Save just committed (or vice versa); a tokenless request keeps the
  // prior unconditional write.
  const guarded = await guardedUserDocumentUpdate({
    userId: user.id,
    document: "medicationListLayout",
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
