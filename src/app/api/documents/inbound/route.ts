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
 * v1.39.2 (#1038) — POST also admits a narrow `documents:write` token, the
 * door another document system (a Paperless workflow, the import script)
 * pushes through. Such a caller gets its own rate bucket, and a receipt
 * (`{ id, duplicate }`) instead of the stored row: a credential that can only
 * add files learns that a file exists, never how its owner filed it. Optional
 * `sourceSystem` / `sourceId` fields key an import so a re-send is a
 * duplicate, including after the person deleted the document; `aiRead=defer`
 * holds back automatic AI reading for the upload.
 *
 * GET lists the caller's documents with title/filename search, kind /
 * episode / year / date-range filters, sort, and keyset pagination — and
 * NEVER selects the encrypted blob column (`omit: { contentEncrypted: true }`).
 *
 * The document is UNTRUSTED (prompt-injection): the server never acts on an
 * instruction inside it. Storing it does nothing with its contents.
 *
 * The request reading, the stored-row answers and the list read live in
 * `src/lib/documents/` (`upload-request.ts`, `upload-answer.ts`,
 * `vault-list.ts`); the store itself is the shared `ingest.ts`.
 */
import { Buffer } from "node:buffer";

import {
  apiHandler,
  isScopedCredential,
  requireAuth,
  requireRecordAuth,
  type AuthContext,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import {
  ingestDocument,
  personalUploadBucket,
  UPLOAD_LIMIT_PER_HOUR,
  UPLOAD_WINDOW_MS,
} from "@/lib/documents/ingest";
import { DOCUMENTS_WRITE_SCOPE } from "@/lib/documents/scopes";
import {
  checkSourceLookupRateLimit,
  findSourceKey,
} from "@/lib/documents/source-key";
import {
  acquireDocumentUploadSlot,
  resolveDocumentLimits,
  resolveDocumentUploadLimitPerHour,
} from "@/lib/documents/upload-policy";
import { storedDocumentBody } from "@/lib/documents/upload-answer";
import {
  aliasLimitResponse,
  answerSourceKey,
  duplicateResponse,
  fileTooLarge,
  receiptResponse,
  type UploadContext,
} from "@/lib/documents/upload-responses";
import {
  parseQuerySourceKey,
  parseUploadMetadata,
  readUploadForm,
  resolveUploadSourceKey,
  type QuerySourceKey,
} from "@/lib/documents/upload-request";
import { listVaultDocuments } from "@/lib/documents/vault-list";
import { withIdempotency } from "@/lib/idempotency";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import type { IngestResult } from "@/lib/documents/ingest";
import { documentListQuerySchema } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

/**
 * Multipart envelope allowance on top of the per-file cap: boundaries plus
 * the small metadata fields (title / kind / documentDate / episodeIds). The
 * exact per-file cap is re-enforced on the extracted file bytes below.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * A source key may ride the query string. It is answered here, before the
 * bucket is charged and before a byte of the body is read: a nightly re-sync
 * of an archive HealthLog already holds costs neither. Answers the response
 * when the key settles the upload, else the key (or null) to carry on with.
 */
async function answerQuerySourceKey(
  request: Request,
  auth: AuthContext,
  scoped: boolean,
): Promise<Response | QuerySourceKey | null> {
  const { user } = auth;
  const query = parseQuerySourceKey(new URL(request.url));
  if (query.kind === "invalid") {
    return apiValidationError(
      "Invalid source key",
      sanitiseZodIssues(query.issues),
      422,
      { errorCode: "documents.inbound.invalidMetadata" },
    );
  }
  const queryKey: QuerySourceKey | null =
    query.kind === "key" ? query.key : null;
  if (queryKey) {
    // Metered like the lookup route, on the same bucket: the check stores
    // nothing and costs no upload slot, but it is not a free oracle either.
    const lookupRl = await checkSourceLookupRateLimit(
      scoped,
      auth.session.id,
      user.id,
    );
    if (!lookupRl.allowed) {
      const response = apiError("Too many lookups. Try again later.", 429, {
        errorCode: "documents.inbound.rateLimited",
      });
      for (const [k, v] of Object.entries(rateLimitHeaders(lookupRl))) {
        response.headers.set(k, v);
      }
      return response;
    }
    const match = await findSourceKey(
      user.id,
      queryKey.sourceSystem,
      queryKey.sourceId,
      queryKey.sourceInstance ?? null,
    );
    if (match) {
      return answerSourceKey(
        {
          userId: user.id,
          scoped,
          sourceSystem: queryKey.sourceSystem,
          aiDeferred: false,
        },
        match,
      );
    }
  }

  return queryKey;
}

/** The answer to an upload the ingest did not store. */
function answerNotStored(
  ctx: UploadContext,
  result: Exclude<IngestResult, { kind: "stored" }>,
): Response | Promise<Response> {
  const scoped = ctx.scoped;
  switch (result.kind) {
    case "sourceKey":
      return answerSourceKey(ctx, result.match);
    case "tooLarge":
      return fileTooLarge(result.maxFileBytes);
    case "empty":
      return apiError("Uploaded file is empty", 422, {
        errorCode: "documents.inbound.invalidMetadata",
      });
    case "unsupportedType":
      return apiError("This file type is not supported.", 415, {
        errorCode: "documents.inbound.fileType",
        reason: "unsupportedType",
      });
    case "episodeNotFound":
      return apiError("Episode not found", 404, {
        errorCode: "documents.inbound.episodeNotFound",
      });
    case "encounterNotFound":
      return apiError("Visit not found", 404, {
        errorCode: "documents.inbound.encounterNotFound",
      });
    case "aliasLimit":
      return aliasLimitResponse();
    case "duplicate":
      return duplicateResponse(ctx, result.document);
    case "quotaExceeded":
      // The figures are the owner's; a write-only token learns only that the
      // vault is full.
      return apiError("Storage quota exceeded.", 413, {
        errorCode: "documents.inbound.quotaExceeded",
        reason: "quotaExceeded",
        ...(scoped
          ? {}
          : { quotaBytes: result.quotaBytes, usedBytes: result.usedBytes }),
      });
  }
}

/** Process one admitted upload. The caller owns and releases its memory slot. */
async function processUpload(
  request: Request,
  auth: AuthContext,
): Promise<Response> {
  const { user } = auth;
  const scoped = isScopedCredential(auth);

  // Opt-in module gate — even a valid Bearer token is refused when the surface
  // is off (it ships dark; the user turns it on deliberately).
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const query = await answerQuerySourceKey(request, auth, scoped);
  if (query instanceof Response) return query;
  const queryKey = query;

  // A scoped token draws on its own bucket, keyed on the token (its id rides
  // `session.id` on the Bearer path), so an import running overnight cannot
  // use up the allowance the person's own uploads from the web or the phone
  // draw on. The cookie / wildcard bucket is unchanged.
  const bucketKey = scoped
    ? `documents-upload:token:${auth.session.id}`
    : personalUploadBucket(user.id);
  const rl = await checkRateLimit(
    bucketKey,
    scoped ? resolveDocumentUploadLimitPerHour() : UPLOAD_LIMIT_PER_HOUR,
    UPLOAD_WINDOW_MS,
  );
  // Every upload that reaches the body pays its slot, stored or not. The cheap
  // way to re-send is the query-string key above, answered before this line;
  // handing slots back after a full body read would let a leaked token send
  // the same bytes under id after id for free.
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

  const read = await readUploadForm(request, bodyCap);
  if (read.kind === "tooLarge") return fileTooLarge(limits.maxFileBytes);
  if (read.kind === "timeout") {
    return apiError("Upload body read timed out.", 408, {
      errorCode: "documents.inbound.uploadTimeout",
      reason: "uploadTimeout",
    });
  }
  if (read.kind === "invalid") return apiError("Invalid multipart body", 400);
  const formData = read.formData;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  const parsed = parseUploadMetadata(formData);
  if (!parsed.success) {
    return apiValidationError(
      "Invalid document metadata",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "documents.inbound.invalidMetadata",
      },
    );
  }

  const key = resolveUploadSourceKey(queryKey, parsed.data);
  if (key.kind === "mismatch") {
    return apiError(
      "The source key in the address and in the form differ.",
      422,
      { errorCode: "documents.inbound.invalidMetadata" },
    );
  }
  const { sourceSystem, sourceId, sourceInstance } = key;
  const ctx: UploadContext = {
    userId: user.id,
    scoped,
    sourceSystem,
    aiDeferred: parsed.data.aiRead === "defer",
  };

  // A source key answers before the bytes are looked at: an import re-sending
  // what it sent before is a duplicate, and one re-sending a document the
  // person deleted is refused a second copy — live and tombstoned rows both
  // count (the unique index has no `deleted_at` predicate), and past the purge
  // the ledger remembers.
  if (sourceSystem && sourceId && !queryKey) {
    const match = await findSourceKey(
      user.id,
      sourceSystem,
      sourceId,
      sourceInstance,
    );
    if (match) return answerSourceKey(ctx, match);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }

  // Everything from here to the stored row is the shared ingest path
  // (`src/lib/documents/ingest.ts`), the one the document picker's import
  // stores through as well.
  const result = await ingestDocument({
    userId: user.id,
    scoped,
    ipAddress: getClientIp(request),
    bytes: buffer,
    filename: typeof file.name === "string" ? file.name : null,
    title: parsed.data.title ?? null,
    kind: parsed.data.kind ?? null,
    documentDate: parsed.data.documentDate ?? null,
    episodeIds: parsed.data.episodeIds ?? [],
    encounterIds: parsed.data.encounterIds ?? [],
    sourceSystem,
    sourceId,
    sourceInstance,
    aiDeferred: ctx.aiDeferred,
    sourceKeyChecked: true,
    limits,
    // Only the AI work queued after a fresh insert follows the capability;
    // the upload itself is data and always accepted.
    documentAi: () => getAiCapability("documentAi"),
  });

  if (result.kind !== "stored") return answerNotStored(ctx, result);

  const document = result.document;
  if (scoped) return receiptResponse(document.id, 201, { duplicate: false });
  return apiSuccess(await storedDocumentBody(user.id, document), 201);
}

/** Authenticate and reserve memory capacity before any request-body read. */
async function postUpload(request: Request): Promise<Response> {
  // One of the two routes that name `documents:write` (the other is the
  // source-key lookup beside it). Every other vault leg —
  // list, detail, original, thumbnail, bulk, AI — declares no scope and so
  // refuses the token (`bearer-scope-enforcement-guard.test.ts`).
  const auth = await requireAuth(DOCUMENTS_WRITE_SCOPE);
  const { user } = auth;
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
    return await processUpload(request, auth);
  } finally {
    releaseUploadSlot();
  }
}

export const POST = apiHandler(withIdempotency<[Request]>(postUpload));

/**
 * GET — list the record's documents (search / filter / sort / paginate).
 *
 * v1.36.x — delegable. `/documents` carries `sharedRecord: true` in the nav
 * model, so the shell offers the destination under a switch and every read
 * behind it refused: the vault rendered a query-error card, and the illness
 * page's episode-documents tile rendered another one beside it. A clinical
 * letter is health data belonging to the record, and reading it is the whole
 * point of handing somebody the record.
 *
 * The POST above is NOT delegable and declares its own scope. Uploading is not
 * a verb the grant admits, and the module-level split matters here: the
 * resolver escalates any non-safe method to `"write"`, so the two arms have to
 * declare separately rather than share one line.
 */
export const GET = apiHandler(async (request: Request) => {
  const { user } = await requireRecordAuth("read", "documents");

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
    return apiValidationError(
      "Invalid list query",
      sanitiseZodIssues(parsed.error.issues),
      422,
      {
        errorCode: "documents.inbound.invalidQuery",
      },
    );
  }

  return apiSuccess(await listVaultDocuments(user.id, parsed.data));
});
