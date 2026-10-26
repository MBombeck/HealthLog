/**
 * Document vault: restore a soft-deleted (tombstoned) document.
 *
 * Delete is undo-able: the DELETE route tombstones (`deletedAt`), the UI
 * shows an "Undo" toast that calls this route, and the daily purge job
 * physically removes tombstones older than the 30-day grace window. This
 * route clears the tombstone; it answers 409 when the row is gone (purged —
 * indistinguishable from never-existed by construction, and owner-scoped
 * either way) or when restoring would collide with a live duplicate of the
 * same bytes (the `inbound_documents_user_sha_live` partial unique index).
 * The restore itself is the shared one (`src/lib/documents/tombstones.ts`):
 * it also clears any import-ledger entry for the document's source keys.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
} from "@/lib/documents/links";
import { serialiseDocumentDetail } from "@/lib/documents/store";
import { restoreDocumentTombstone } from "@/lib/documents/tombstones";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** Shares the write posture of the other owner-scoped document mutations. */
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
    const outcome = await restoreDocumentTombstone(user.id, id);
    if (outcome.kind === "gone") {
      // Purged (past the 30-day grace, or deleted now from Recently deleted)
      // or never existed — the tombstone is gone either way, so the undo
      // window is over: 409, not 404.
      return apiError("This document can no longer be restored.", 409, {
        errorCode: "documents.inbound.restoreGone",
        reason: "purged",
      });
    }
    if (outcome.kind === "duplicate") {
      return apiError("An identical document is already stored.", 409, {
        errorCode: "documents.inbound.restoreDuplicate",
        reason: "duplicateExists",
        ...(outcome.existingId ? { existingId: outcome.existingId } : {}),
      });
    }

    const restored = await prisma.inboundDocument.findFirstOrThrow({
      where: { id, userId: user.id },
      omit: { contentEncrypted: true },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
    const [links, visitLinks] = await Promise.all([
      loadConditionLinks(user.id, [restored.id]),
      loadDocumentEncounterLinks(user.id, [restored.id]),
    ]);

    // Restoring an already-live document is a no-op success (the undo toast
    // may fire after a concurrent restore); only a real restore is audited.
    if (outcome.kind === "restored") {
      await auditLog("documents.inbound.restore", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { documentId: restored.id },
      });
    }

    annotate({
      action: { name: "documents.vault.restore" },
      meta: { documentId: restored.id, alreadyLive: outcome.kind === "live" },
    });

    return apiSuccess(
      serialiseDocumentDetail(
        restored,
        restored.facts,
        links.get(restored.id) ?? [],
        false,
        null,
        false,
        visitLinks.get(restored.id) ?? [],
      ),
    );
  },
);
