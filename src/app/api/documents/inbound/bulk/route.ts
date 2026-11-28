/**
 * Document vault: bulk actions over up to 100 owner-scoped documents.
 *
 * `{ ids[], action, kind?, episodeId?, encounterId? }` → a per-id result
 * array. Actions: `setKind` (recategorise), `linkEpisode` / `unlinkEpisode`
 * (condition links), `linkEncounter` / `unlinkEncounter` (visit links, the
 * same table the visit's own sheet writes from the other end),
 * `delete` (tombstone, undo-able), `restore` (clear tombstone). A
 * partial failure never aborts the batch — each id reports `ok` or a short
 * machine reason. Each action runs over the whole set in a bounded number of
 * statements, whatever the batch size. Every id is narrowed to the record; a foreign id reads as
 * "notFound", exactly like the single-document routes.
 *
 * #1403 — the owner's, and a managed profile's guardian's (`"guardian"`),
 * like every single-document verb it batches. An adult's share reaches none
 * of it at any level.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { restoreDocumentTombstones } from "@/lib/documents/tombstones";
import { linkTargets, unlinkTargets } from "@/lib/links";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentBulkSchema,
  type DocumentBulkResultDto,
} from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/**
 * One bulk call covers up to 100 rows, so the bucket is tighter than the
 * single-row write bucket (240/h) while allowing the same overall throughput.
 * Keyed on the person acting, like the single-row bucket.
 */
const BULK_LIMIT_PER_HOUR = 60;
const BULK_WINDOW_MS = 60 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user, actor, grantId } = await requireRecordAuth(
    "guardian",
    "documents",
  );
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `documents-bulk:${actor.id}`,
    BULK_LIMIT_PER_HOUR,
    BULK_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const parsed = await parseJsonBody(request, documentBulkSchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;
  const { ids, action, kind, episodeId, encounterId } = parsed.data;
  const uniqueIds = [...new Set(ids)];

  // The link actions reach into another section of the record; a section the
  // grant does not cover answers like a foreign target (see the PATCH).
  const visible = await actingDomainVisibility(prisma, grantId);

  // Episode actions: the target episode must be a LIVE episode of the record.
  if (action === "linkEpisode" || action === "unlinkEpisode") {
    const episode = !visible("illness")
      ? null
      : await prisma.illnessEpisode.findFirst({
          where: { id: episodeId!, userId: user.id, deletedAt: null },
          select: { id: true },
        });
    if (!episode) {
      return apiError("Episode not found", 404, {
        errorCode: "documents.inbound.episodeNotFound",
      });
    }
  }

  // Visit actions: the target visit must be a LIVE visit of the record. Same
  // shape as the episode gate above — the endpoint is checked once, before the
  // batch, so a foreign id costs one refusal rather than a hundred.
  if (action === "linkEncounter" || action === "unlinkEncounter") {
    const encounter = !visible("profile")
      ? null
      : await prisma.encounter.findFirst({
          where: { id: encounterId!, userId: user.id, deletedAt: null },
          select: { id: true },
        });
    if (!encounter) {
      return apiError("Visit not found", 404, {
        errorCode: "documents.inbound.encounterNotFound",
      });
    }
  }

  // One record-scoped sweep resolves every id's current state; the action
  // then runs over the set in a fixed number of statements, never one per id
  // (a hundred single-row writes in sequence held a request for seconds under
  // load). Every write stays narrowed to the record.
  const owned = await prisma.inboundDocument.findMany({
    where: { id: { in: uniqueIds }, userId: user.id },
    select: { id: true, deletedAt: true },
  });
  const byId = new Map(owned.map((d) => [d.id, d]));
  const ownedIds = owned.map((d) => d.id);
  const liveIds = owned.filter((d) => d.deletedAt === null).map((d) => d.id);

  // Ids the action applied to; every other owned id gets `failed[id]`, and an
  // id the record does not own reads "notFound".
  let applied: ReadonlySet<string>;
  const failed = new Map<string, string>();

  switch (action) {
    case "setKind": {
      // A tombstoned document is not recategorised: "notFound", like the PATCH.
      const updated = await prisma.inboundDocument.updateManyAndReturn({
        where: { id: { in: liveIds }, userId: user.id, deletedAt: null },
        data: { kind: kind! },
        select: { id: true },
      });
      applied = new Set(updated.map((d) => d.id));
      break;
    }
    case "linkEpisode":
    case "linkEncounter": {
      // Filed from the target's end: one call links every live document, and
      // the service re-reads both ends scoped by the record. The link tables
      // are the same from either end.
      const targetKind =
        action === "linkEpisode" ? "conditionEpisode" : "encounter";
      const targetId = action === "linkEpisode" ? episodeId! : encounterId!;
      const linked =
        liveIds.length === 0
          ? null
          : await linkTargets(prisma, {
              userId: user.id,
              sourceKind: targetKind,
              sourceId: targetId,
              targetKind: "document",
              targetIds: liveIds,
            });
      // The target was checked live above; losing it since links nothing.
      const refused = new Set(
        linked?.unknownSource ? liveIds : (linked?.unknownTargetIds ?? []),
      );
      applied = new Set(liveIds.filter((id) => !refused.has(id)));
      break;
    }
    case "unlinkEpisode":
    case "unlinkEncounter": {
      // No tombstone check: clearing a filing on a document the account has
      // since deleted must stay possible, or the filing is unreachable.
      if (ownedIds.length > 0) {
        await unlinkTargets(prisma, {
          userId: user.id,
          sourceKind:
            action === "unlinkEpisode" ? "conditionEpisode" : "encounter",
          sourceId: action === "unlinkEpisode" ? episodeId! : encounterId!,
          targetKind: "document",
          targetIds: ownedIds,
        });
      }
      applied = new Set(ownedIds);
      break;
    }
    case "delete": {
      // Already tombstoned is a no-op success, so every owned id succeeds:
      // one the update skipped was tombstoned in between.
      if (liveIds.length > 0) {
        await prisma.inboundDocument.updateMany({
          where: { id: { in: liveIds }, userId: user.id, deletedAt: null },
          data: { deletedAt: new Date(), status: "DISCARDED" },
        });
      }
      applied = new Set(ownedIds);
      break;
    }
    case "restore": {
      // The shared restore: the duplicate check, the status the staged facts
      // imply, and the import-ledger cleanup. Already live is a no-op success.
      const outcomes = await restoreDocumentTombstones(user.id, ownedIds);
      const ok = new Set<string>();
      for (const [id, outcome] of outcomes) {
        if (outcome.kind === "restored" || outcome.kind === "live") ok.add(id);
        else if (outcome.kind === "duplicate") failed.set(id, "conflict");
      }
      applied = ok;
      break;
    }
  }

  const results: DocumentBulkResultDto[] = uniqueIds.map((id) =>
    byId.has(id) && applied.has(id)
      ? { id, ok: true, error: null }
      : { id, ok: false, error: failed.get(id) ?? "notFound" },
  );

  const okCount = results.filter((r) => r.ok).length;

  await auditLog("documents.inbound.bulk", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { action, requested: uniqueIds.length, succeeded: okCount },
  });

  annotate({
    action: { name: "documents.vault.bulk" },
    meta: { bulkAction: action, requested: uniqueIds.length, ok: okCount },
  });

  return apiSuccess({ results });
});
