/**
 * Document vault: store-first upload + browsable list.
 *
 * POST is STORE-ONLY and provider-free. A self-hoster uploads any accepted
 * document; it is stored ENCRYPTED at rest (binary codec) with
 * `status: STORED` and NO extraction run. There is no provider resolution, no
 * AI consent guard, no budget, and NO egress on this path — a file can always
 * be filed, even on an account with no document-scan provider configured.
 *
 * The upload path enforces the vault policy layer
 * (`src/lib/documents/upload-policy.ts`): magic-byte classification (the wire
 * Content-Type is never trusted), the admin-tunable per-file cap (bounded
 * read aborts at the cap), the per-user quota (checked in the same
 * transaction as the insert, tombstone-inclusive), sha256 duplicate detection
 * (a same-user re-upload returns the existing live row, never a second copy),
 * an honoured `Idempotency-Key`, and optional `episodeIds[]` pre-linking.
 *
 * GET lists the caller's documents with title/filename search, kind /
 * episode / year / date-range filters, sort, and keyset pagination — and
 * NEVER selects the encrypted blob column (`omit: { contentEncrypted: true }`).
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. Storing it does nothing with its contents.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { apiHandler, requireAuth, type AuthContext } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { hashQueryTokens } from "@/lib/documents/content-index";
import {
  loadConditionLinks,
  narrowOwnedEpisodeIds,
} from "@/lib/documents/links";
import {
  encryptDocumentContent,
  serialiseDocument,
  type SerialisableDocument,
} from "@/lib/documents/store";
import { enqueueDocumentIndex } from "@/lib/jobs/document-index";
import { enqueueDocumentSummary } from "@/lib/jobs/document-summary";
import { enqueueDocumentThumbnail } from "@/lib/jobs/document-thumbnail";
import {
  acquireDocumentUploadSlot,
  detectDocumentType,
  resolveDocumentLimits,
} from "@/lib/documents/upload-policy";
import { withIdempotency } from "@/lib/idempotency";
import { BodyTooLargeError, readBoundedBody } from "@/lib/labs/ocr-upload";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { isP2002 } from "@/lib/prisma-errors";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  documentCreateSchema,
  documentListQuerySchema,
  toContentIndexSource,
} from "@/lib/validations/inbound-documents";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * A store-only upload touches no provider — the only abuse vector is disk, so
 * a generous per-user ceiling is enough (extraction has its own tight gate).
 */
const UPLOAD_LIMIT_PER_HOUR = 60;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

/**
 * Multipart envelope allowance on top of the per-file cap: boundaries plus
 * the small metadata fields (title / kind / documentDate / episodeIds). The
 * exact per-file cap is re-enforced on the extracted file bytes below.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const UPLOAD_BODY_TIMEOUT_MS = 30_000;

/** Parse a YYYY-MM-DD form field into a UTC midnight Date. */
function isoDateToUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** §3.2 — 413 fileTooLarge with the configured limit in `meta`. */
function fileTooLarge(maxFileBytes: number): NextResponse {
  return apiError("File is too large.", 413, {
    errorCode: "documents.inbound.fileTooLarge",
    reason: "fileTooLarge",
    maxFileBytes,
  });
}

/** Internal signal: the quota gate inside the insert transaction tripped. */
class QuotaExceededError extends Error {
  constructor(public readonly usedBytes: number) {
    super("Document quota exceeded");
    this.name = "QuotaExceededError";
  }
}

/**
 * §3.2 — a duplicate upload is NOT an error: return the existing live row
 * with `meta.duplicate: true` at the envelope level (the UI toasts "already
 * stored" and highlights the row).
 */
async function duplicateResponse(
  userId: string,
  existing: SerialisableDocument,
): Promise<NextResponse> {
  const [links, groups] = await Promise.all([
    loadConditionLinks(userId, [existing.id]),
    prisma.extractedFact.groupBy({
      by: ["status"],
      where: { userId, documentId: existing.id },
      _count: { _all: true },
    }),
  ]);
  let factCount = 0;
  let pendingCount = 0;
  for (const g of groups) {
    if (g.status !== "REJECTED") factCount += g._count._all;
    if (g.status === "PENDING") pendingCount += g._count._all;
  }
  annotate({
    action: { name: "documents.vault.upload" },
    meta: { documentId: existing.id, duplicate: true },
  });
  return NextResponse.json(
    {
      data: serialiseDocument(
        existing,
        { factCount, pendingCount },
        links.get(existing.id) ?? [],
      ),
      error: null,
      meta: { duplicate: true },
    },
    { status: 200 },
  );
}

/** Process one admitted upload. The caller owns and releases its memory slot. */
async function processUpload(
  request: Request,
  user: AuthContext["user"],
): Promise<Response> {
  // Opt-in module gate — even a valid Bearer token is refused when the surface
  // is off (it ships dark; the user turns it on deliberately).
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `documents-upload:${user.id}`,
    UPLOAD_LIMIT_PER_HOUR,
    UPLOAD_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many uploads. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const limits = await resolveDocumentLimits(user.id);
  const bodyCap = limits.maxFileBytes + MULTIPART_OVERHEAD_BYTES;

  // Instant rejection on a declared oversize (a CD/ISO-sized upload never
  // allocates); the bounded read below covers chunked/undeclared bodies.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > bodyCap) {
    return fileTooLarge(limits.maxFileBytes);
  }

  let formData: FormData;
  try {
    const bytes = await readBoundedBody(request.body, bodyCap, {
      signal: request.signal,
      deadline: Date.now() + UPLOAD_BODY_TIMEOUT_MS,
    });
    formData = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: bytes,
    }).formData();
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return fileTooLarge(limits.maxFileBytes);
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      return apiError("Upload body read timed out.", 408, {
        errorCode: "documents.inbound.uploadTimeout",
        reason: "uploadTimeout",
      });
    }
    return apiError("Invalid multipart body", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  // Optional metadata (title / kind / documentDate / episodeIds). The file is
  // read separately; these are the form fields beside it. `episodeIds` may be
  // repeated.
  const rawEpisodeIds = formData
    .getAll("episodeIds")
    .filter((v): v is string => typeof v === "string");
  const parsed = documentCreateSchema.safeParse({
    title: formData.get("title") ?? undefined,
    kind: formData.get("kind") ?? undefined,
    documentDate: formData.get("documentDate") ?? undefined,
    episodeIds: rawEpisodeIds.length > 0 ? rawEpisodeIds : undefined,
  });
  if (!parsed.success) {
    return apiError("Invalid document metadata", 422, {
      errorCode: "documents.inbound.invalidMetadata",
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }
  if (buffer.byteLength > limits.maxFileBytes) {
    return fileTooLarge(limits.maxFileBytes);
  }
  if (buffer.byteLength === 0) {
    return apiError("Uploaded file is empty", 422, {
      errorCode: "documents.inbound.invalidMetadata",
    });
  }

  // §3.1 — magic-byte classification; the wire Content-Type is never trusted.
  const detected = detectDocumentType(
    buffer,
    typeof file.name === "string" ? file.name : null,
  );
  if (!detected) {
    return apiError("This file type is not supported.", 415, {
      errorCode: "documents.inbound.fileType",
      reason: "unsupportedType",
    });
  }

  // Pre-linking: every episode id must be a LIVE episode of the caller.
  const episodeIds = await narrowOwnedEpisodeIds(
    user.id,
    parsed.data.episodeIds ?? [],
  );
  if (episodeIds === null) {
    return apiError("Episode not found", 404, {
      errorCode: "documents.inbound.episodeNotFound",
    });
  }

  // sha256 of the PLAINTEXT for same-user duplicate detection.
  const contentSha256 = createHash("sha256").update(buffer).digest("hex");

  // Fast-path dedupe check; the partial unique index closes the race below.
  const existing = await prisma.inboundDocument.findFirst({
    where: { userId: user.id, contentSha256, deletedAt: null },
    omit: { contentEncrypted: true },
  });
  if (existing) {
    return duplicateResponse(user.id, existing);
  }

  // Quota gate + insert + pre-links in ONE transaction. Usage counts every
  // non-purged row — tombstones still hold TOAST bytes, so "deleted" bytes
  // are never invisible weight (undo-delete never changes usage).
  let document: SerialisableDocument;
  try {
    document = await prisma.$transaction(async (tx) => {
      // Serialise the quota gate per user: without this, N concurrent
      // uploads all read the same SUM before any of them commits and the
      // quota can be overshot by up to N × cap in one burst. The advisory
      // lock is transaction-scoped (released on commit/rollback) and keyed
      // on the user id, so uploads by different users never queue on each
      // other.
      // (`pg_advisory_xact_lock` returns void, which the client cannot
      // deserialize as a column — selecting FROM it yields a plain int row.)
      await tx.$queryRaw`
        SELECT 1 AS locked
        FROM pg_advisory_xact_lock(hashtextextended('documents-quota:' || ${user.id}, 0))
      `;
      const rows = await tx.$queryRaw<Array<{ used: bigint }>>`
        SELECT COALESCE(SUM(byte_size), 0)::bigint AS used
        FROM inbound_documents
        WHERE user_id = ${user.id}
      `;
      const usedBytes = Number(rows[0]?.used ?? 0);
      if (usedBytes + buffer.byteLength > limits.quotaBytes) {
        throw new QuotaExceededError(usedBytes);
      }

      const { content, codec } = encryptDocumentContent(buffer);

      // No mass assignment — every column is set field-by-field; `userId`
      // comes from the session, never the body. `documentDate` defaults to
      // the upload day so display == sort == filter (user-editable later).
      const created = await tx.inboundDocument.create({
        data: {
          userId: user.id,
          kind: parsed.data.kind ?? "OTHER",
          // Stored plaintext on purpose (mirrors `filename`) so the list can
          // ILIKE-search + ORDER BY it. It MAY hold PHI the user types; that
          // is the accepted tradeoff for server-side search/sort — the
          // document body stays encrypted.
          title: parsed.data.title ?? null,
          filename:
            typeof file.name === "string" ? file.name.slice(0, 255) : null,
          mimeType: detected.mimeType,
          byteSize: buffer.byteLength,
          contentEncrypted: content,
          contentCodec: codec,
          contentSha256,
          status: "STORED",
          documentDate: parsed.data.documentDate
            ? isoDateToUtc(parsed.data.documentDate)
            : new Date(),
        },
        omit: { contentEncrypted: true },
      });

      if (episodeIds.length > 0) {
        await tx.documentConditionLink.createMany({
          data: episodeIds.map((episodeId) => ({
            documentId: created.id,
            episodeId,
            userId: user.id,
          })),
        });
      }
      return created;
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return apiError("Storage quota exceeded.", 413, {
        errorCode: "documents.inbound.quotaExceeded",
        reason: "quotaExceeded",
        quotaBytes: limits.quotaBytes,
        usedBytes: err.usedBytes,
      });
    }
    if (isP2002(err)) {
      // A racing upload of the same bytes won the partial unique index.
      // Surface the winner as the duplicate — same outcome as the fast path.
      const winner = await prisma.inboundDocument.findFirst({
        where: { userId: user.id, contentSha256, deletedAt: null },
        omit: { contentEncrypted: true },
      });
      if (winner) return duplicateResponse(user.id, winner);
    }
    throw err;
  }

  await auditLog("documents.inbound.store", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { documentId: document.id, mime: detected.mimeType },
  });

  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: document.id,
      byteSize: document.byteSize,
      servingClass: detected.servingClass,
      linked: episodeIds.length,
    },
  });

  // Auto-index the freshly stored document for content search: enqueue a
  // fire-and-forget background job (provider-first, local text-layer fallback).
  // The upload response never blocks on or fails because of indexing — the
  // enqueue is not awaited and swallows its own errors (a missing boss or a
  // transient send failure is a silent no-op). Only fresh inserts enqueue — a
  // duplicate upload returns early above and never reaches here.
  void enqueueDocumentIndex(user.id, document.id);

  // Render a preview thumbnail in the background too (pure local compute — no
  // egress). Same fire-and-forget contract: the upload never blocks on or fails
  // because of it, and a dropped enqueue is recoverable via the boot backfill.
  // Only fresh inserts reach here (a duplicate returns early above).
  void enqueueDocumentThumbnail(user.id, document.id);

  // Summarise the freshly stored document in the background — but ONLY when the
  // `documentsAutoAiRead` opt-in is ON (the job re-checks it and the egress
  // consent, and no-ops otherwise). The persisted summary shows on the detail
  // view. Same fire-and-forget contract: the upload never blocks on or fails
  // because of it. Only fresh inserts reach here (a duplicate returns early).
  void enqueueDocumentSummary(user.id, document.id);

  const links = await loadConditionLinks(user.id, [document.id]);
  return apiSuccess(
    serialiseDocument(
      document,
      { factCount: 0, pendingCount: 0 },
      links.get(document.id) ?? [],
    ),
    201,
  );
}

/** Authenticate and reserve memory capacity before any request-body read. */
async function postUpload(request: Request): Promise<Response> {
  const { user } = await requireAuth();
  const releaseUploadSlot = acquireDocumentUploadSlot(user.id);
  if (!releaseUploadSlot) {
    const response = apiError(
      "Too many uploads are already in progress. Try again shortly.",
      429,
      {
        errorCode: "documents.inbound.uploadBusy",
        reason: "uploadBusy",
      },
    );
    response.headers.set("Retry-After", "1");
    return response;
  }

  try {
    return await processUpload(request, user);
  } finally {
    releaseUploadSlot();
  }
}

export const POST = apiHandler(withIdempotency<[Request]>(postUpload));

/** GET — list the caller's documents (search / filter / sort / paginate). */
export const GET = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const url = new URL(request.url);
  // `kind` is a multi-value facet: repeated params and/or comma-separated.
  const kinds = url.searchParams
    .getAll("kind")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const single = Object.fromEntries(url.searchParams);
  const parsed = documentListQuerySchema.safeParse({
    ...single,
    kind: kinds.length > 0 ? kinds : undefined,
  });
  if (!parsed.success) {
    return apiError("Invalid list query", 422, {
      errorCode: "documents.inbound.invalidQuery",
    });
  }
  const { q, kind, episodeId, year, from, to, sort, order, cursor, limit } =
    parsed.data;

  const where: Prisma.InboundDocumentWhereInput = {
    userId: user.id,
    deletedAt: null,
  };
  if (kind && kind.length > 0) where.kind = { in: kind };
  if (episodeId) where.conditionLinks = { some: { episodeId } };
  if (year !== undefined) {
    where.documentDate = {
      gte: new Date(Date.UTC(year, 0, 1)),
      lt: new Date(Date.UTC(year + 1, 0, 1)),
    };
  } else if (from || to) {
    where.documentDate = {
      ...(from ? { gte: isoDateToUtc(from) } : {}),
      // inclusive end-of-day for the `to` bound
      ...(to ? { lt: new Date(isoDateToUtc(to).getTime() + 86_400_000) } : {}),
    };
  }
  if (q) {
    // Substring match on the short plaintext fields …
    const or: Prisma.InboundDocumentWhereInput[] = [
      { title: { contains: q, mode: "insensitive" } },
      { filename: { contains: q, mode: "insensitive" } },
    ];
    // … unioned with a WHOLE-WORD content match over the blind token index.
    // The query is tokenised + HMAC'd the same way the index was built, then
    // matched with a GIN-accelerated array-overlap (`hasSome` → `&&`). The
    // list still never selects the encrypted text — only the opaque hashes are
    // touched, in the related table. Degrades silently to title/filename when
    // the caller has no indexed documents (no rows overlap).
    const hashes = hashQueryTokens(q);
    if (hashes.length > 0) {
      or.push({ contentIndex: { is: { searchTokens: { hasSome: hashes } } } });
    }
    where.OR = or;
  }

  // Keyset pagination on the sort column + a stable `id` tiebreak; nullable
  // sort columns sort nulls last so undated documents trail.
  const primaryOrder:
    Prisma.InboundDocumentOrderByWithRelationInput | undefined =
    sort === "documentDate"
      ? { documentDate: { sort: order, nulls: "last" } }
      : sort === "title"
        ? { title: { sort: order, nulls: "last" } }
        : { createdAt: order };
  const orderBy: Prisma.InboundDocumentOrderByWithRelationInput[] = [
    primaryOrder,
    { id: order },
  ];

  // Hardening: the list NEVER fetches the encrypted blob column — a page of
  // 50 rows would otherwise drag up to 50 × cap ciphertext bytes per request.
  const rows = await prisma.inboundDocument.findMany({
    where,
    omit: { contentEncrypted: true },
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  // Fact tallies for the whole page in ONE grouped count — no per-document
  // fan-out and no materialising fact-id rows. `factCount` counts every
  // non-REJECTED fact (a rejected fact is discarded, not part of the
  // document's tally), `pendingCount` the PENDING subset awaiting review.
  const factCounts = new Map<
    string,
    { factCount: number; pendingCount: number }
  >();
  if (page.length > 0) {
    const groups = await prisma.extractedFact.groupBy({
      by: ["documentId", "status"],
      where: { userId: user.id, documentId: { in: page.map((d) => d.id) } },
      _count: { _all: true },
    });
    for (const g of groups) {
      const entry = factCounts.get(g.documentId) ?? {
        factCount: 0,
        pendingCount: 0,
      };
      const n = g._count._all;
      if (g.status !== "REJECTED") entry.factCount += n;
      if (g.status === "PENDING") entry.pendingCount += n;
      factCounts.set(g.documentId, entry);
    }
  }

  // Condition links for the page in ONE grouped query (no N+1).
  const linkMap = await loadConditionLinks(
    user.id,
    page.map((d) => d.id),
  );

  // Which of the page's documents have a content index (drives the searchable
  // status + the provenance the UI reads to tell an AI-read document from a
  // locally-indexed one). One grouped query; never the ciphertext.
  const indexSources = new Map<string, string>();
  if (page.length > 0) {
    const indexed = await prisma.documentContentIndex.findMany({
      where: { userId: user.id, documentId: { in: page.map((d) => d.id) } },
      select: { documentId: true, source: true },
    });
    for (const row of indexed) indexSources.set(row.documentId, row.source);
  }

  // Which of the page's documents have a preview thumbnail (gates the card's
  // <img>). One grouped query on the 1:1 side table; never the blob column.
  const thumbnailIds = new Set<string>();
  if (page.length > 0) {
    const thumbs = await prisma.documentThumbnail.findMany({
      where: { userId: user.id, documentId: { in: page.map((d) => d.id) } },
      select: { documentId: true },
    });
    for (const row of thumbs) thumbnailIds.add(row.documentId);
  }

  annotate({
    action: { name: "documents.inbound.list" },
    meta: {
      count: page.length,
      sort,
      order,
      filtered: Boolean(q || (kind && kind.length > 0) || episodeId || year),
    },
  });

  return apiSuccess({
    documents: page.map((doc) =>
      serialiseDocument(
        doc,
        factCounts.get(doc.id) ?? { factCount: 0, pendingCount: 0 },
        linkMap.get(doc.id) ?? [],
        indexSources.has(doc.id),
        toContentIndexSource(indexSources.get(doc.id)),
        thumbnailIds.has(doc.id),
      ),
    ),
    nextCursor,
  });
});
