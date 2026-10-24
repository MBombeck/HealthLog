/**
 * Document vault: remove one deleted document for good, now.
 *
 * "Delete now" in Recently deleted. The daily job purges a deleted document
 * once the grace window has passed; this does the same for one document
 * ahead of time, through the same function (`purgeDocumentTombstones` in
 * `src/lib/documents/tombstones.ts`): the row and everything that cascades
 * from it go, and an imported document's source keys are carried into the
 * import ledger in the same transaction, so a re-run of the importer does not
 * bring it back.
 *
 * Only a deleted document can be purged: a live one answers 409
 * `documents.inbound.notDeleted`, so no single request takes a document from
 * the vault straight out of the database. Owner-only, like delete and restore.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { purgeDocumentTombstoneNow } from "@/lib/documents/tombstones";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { DocumentPurgeDto } from "@/lib/validations/inbound-documents";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Shares the write bucket of the other owner-scoped document mutations. */
const WRITE_LIMIT_PER_HOUR = 240;
const WRITE_WINDOW_MS = 60 * 60 * 1000;

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `documents-write:${user.id}`,
      WRITE_LIMIT_PER_HOUR,
      WRITE_WINDOW_MS,
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

    const { id } = await params;
    const row = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id },
      select: { id: true, deletedAt: true },
    });
    if (!row) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }
    if (row.deletedAt === null) {
      return apiError("Only a deleted document can be removed for good.", 409, {
        errorCode: "documents.inbound.notDeleted",
      });
    }

    const purged = await purgeDocumentTombstoneNow(user.id, row.id);
    if (!purged) {
      // Lost a race between the read above and the purge: a restore brought
      // it back (409, as above), or the daily purge took it first, which is
      // what was asked for.
      const now = await prisma.inboundDocument.findFirst({
        where: { id: row.id, userId: user.id },
        select: { deletedAt: true },
      });
      if (now && now.deletedAt === null) {
        return apiError(
          "Only a deleted document can be removed for good.",
          409,
          { errorCode: "documents.inbound.notDeleted" },
        );
      }
    }

    await auditLog("documents.inbound.purge", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { documentId: row.id },
    });

    annotate({
      action: { name: "documents.trash.purge" },
      meta: { documentId: row.id, raced: !purged },
    });

    const body: DocumentPurgeDto = { id: row.id, purged: true };
    return apiSuccess(body);
  },
);
