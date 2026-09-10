/**
 * v1.25 — inbound clinical document by id: detail + metadata edit + discard.
 *
 * GET returns the document plus its staged facts for the review screen.
 * PATCH renames / recategorises / sets the user filing date (no mass
 * assignment; `userId` from the session feeds the `where`).
 * DELETE soft-deletes (tombstone) and marks the document DISCARDED — facts
 * already approved into the structured stores are independent rows and stay.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  loadConditionLinks,
  loadDocumentEncounterLinks,
  narrowOwnedEncounterIds,
  narrowOwnedEpisodeIds,
  replaceConditionLinks,
  replaceEncounterLinks,
} from "@/lib/documents/links";
import { serialiseDocumentDetail } from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentUpdateSchema,
  toContentIndexSource,
} from "@/lib/validations/inbound-documents";
import type { Prisma } from "@/generated/prisma/client";

type RouteParams = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/**
 * Edit / discard are owner-scoped, so a generous per-user ceiling is just a
 * self-DoS backstop. PATCH and DELETE share one write bucket.
 */
const WRITE_LIMIT_PER_HOUR = 240;
const WRITE_WINDOW_MS = 60 * 60 * 1000;

/** Shared 429 helper for the mutating routes. */
async function enforceWriteRateLimit(userId: string): Promise<Response | null> {
  const rl = await checkRateLimit(
    `documents-write:${userId}`,
    WRITE_LIMIT_PER_HOUR,
    WRITE_WINDOW_MS,
  );
  if (rl.allowed) return null;
  const response = apiError("Too many requests. Try again later.", 429, {
    errorCode: "documents.inbound.rateLimited",
  });
  for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
    response.headers.set(k, v);
  }
  return response;
}

/**
 * GET — one document of the record, with its facts and condition links.
 *
 * v1.36.x — delegable. The list beside it is; opening a row from that list is
 * the same read one document deeper, and a vault whose rows cannot be opened
 * is a vault the delegate can only count. The row is fetched under the
 * resolved user id before anything is serialised, so the substitution reaches
 * the query rather than a filter after it.
 *
 * The PATCH and DELETE below keep `requireAuth()`. Retyping a document,
 * relabelling it and deleting it are edits, and an edit stays with the owner —
 * including of a document the delegate has just read.
 */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "documents");
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      omit: { contentEncrypted: true },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    const [links, visitLinks, contentIndex, thumbnail] = await Promise.all([
      loadConditionLinks(user.id, [document.id]),
      loadDocumentEncounterLinks(user.id, [document.id]),
      prisma.documentContentIndex.findUnique({
        where: { documentId: document.id },
        select: { source: true },
      }),
      prisma.documentThumbnail.findUnique({
        where: { documentId: document.id },
        select: { id: true },
      }),
    ]);

    annotate({
      action: { name: "documents.inbound.get" },
      meta: { documentId: id, facts: document.facts.length },
    });

    return apiSuccess(
      serialiseDocumentDetail(
        document,
        document.facts,
        links.get(document.id) ?? [],
        contentIndex !== null,
        toContentIndexSource(contentIndex?.source),
        thumbnail !== null,
        visitLinks.get(document.id) ?? [],
      ),
    );
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const limited = await enforceWriteRateLimit(user.id);
    if (limited) return limited;

    const { id } = await params;

    const { data: body, error: jsonError } = await safeJson(request);
    if (jsonError) return jsonError;

    const parsed = documentUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return apiValidationError(
        "Invalid document update",
        sanitiseZodIssues(parsed.error.issues),
        422,
        {
          errorCode: "documents.inbound.invalidUpdate",
        },
      );
    }

    const existing = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    // Replace-set condition links: every episode id must be a LIVE episode
    // of the caller — a foreign/unknown id gets a 404-shaped refusal.
    let nextEpisodeIds: string[] | undefined;
    if (parsed.data.episodeIds !== undefined) {
      const narrowed = await narrowOwnedEpisodeIds(
        user.id,
        parsed.data.episodeIds,
      );
      if (narrowed === null) {
        return apiError("Episode not found", 404, {
          errorCode: "documents.inbound.episodeNotFound",
        });
      }
      nextEpisodeIds = narrowed;
    }

    // Replace-set visit links, same semantics and same refusal.
    let nextEncounterIds: string[] | undefined;
    if (parsed.data.encounterIds !== undefined) {
      const narrowed = await narrowOwnedEncounterIds(
        user.id,
        parsed.data.encounterIds,
      );
      if (narrowed === null) {
        return apiError("Visit not found", 404, {
          errorCode: "documents.inbound.encounterNotFound",
        });
      }
      nextEncounterIds = narrowed;
    }

    // No mass assignment — each editable column is set explicitly only when
    // the client sent it. `userId` is never a body field.
    const data: Prisma.InboundDocumentUpdateInput = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;
    if (parsed.data.documentDate !== undefined) {
      data.documentDate = parsed.data.documentDate
        ? new Date(`${parsed.data.documentDate}T00:00:00.000Z`)
        : null;
    }

    if (Object.keys(data).length > 0) {
      await prisma.inboundDocument.update({
        where: { id: existing.id },
        data,
      });
    }
    if (nextEpisodeIds !== undefined) {
      await replaceConditionLinks(prisma, user.id, existing.id, nextEpisodeIds);
    }
    if (nextEncounterIds !== undefined) {
      await replaceEncounterLinks(
        prisma,
        user.id,
        existing.id,
        nextEncounterIds,
      );
    }

    const document = await prisma.inboundDocument.findFirstOrThrow({
      where: { id: existing.id },
      omit: { contentEncrypted: true },
      include: { facts: { orderBy: { createdAt: "asc" } } },
    });
    const [links, visitLinks, contentIndex, thumbnail] = await Promise.all([
      loadConditionLinks(user.id, [document.id]),
      loadDocumentEncounterLinks(user.id, [document.id]),
      prisma.documentContentIndex.findUnique({
        where: { documentId: document.id },
        select: { source: true },
      }),
      prisma.documentThumbnail.findUnique({
        where: { documentId: document.id },
        select: { id: true },
      }),
    ]);

    const touched = [
      ...Object.keys(data),
      ...(nextEpisodeIds !== undefined ? ["episodeIds"] : []),
      ...(nextEncounterIds !== undefined ? ["encounterIds"] : []),
    ];

    await auditLog("documents.inbound.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        documentId: existing.id,
        fields: touched,
      },
    });

    annotate({
      action: { name: "documents.inbound.update" },
      meta: { documentId: existing.id, fields: touched.join(",") },
    });

    return apiSuccess(
      serialiseDocumentDetail(
        document,
        document.facts,
        links.get(document.id) ?? [],
        contentIndex !== null,
        toContentIndexSource(contentIndex?.source),
        thumbnail !== null,
        visitLinks.get(document.id) ?? [],
      ),
    );
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const limited = await enforceWriteRateLimit(user.id);
    if (limited) return limited;

    const { id } = await params;
    const document = await prisma.inboundDocument.findFirst({
      where: { id, userId: user.id, deletedAt: null },
      select: { id: true },
    });
    if (!document) {
      return apiError("Document not found", 404, {
        errorCode: "documents.inbound.notFound",
      });
    }

    await prisma.inboundDocument.update({
      where: { id: document.id },
      data: { deletedAt: new Date(), status: "DISCARDED" },
    });

    await auditLog("documents.inbound.discard", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { documentId: document.id },
    });

    annotate({
      action: { name: "documents.inbound.discard" },
      meta: { documentId: document.id },
    });

    return apiSuccess({ id: document.id, discarded: true });
  },
);
