/**
 * The answers a vault upload (`POST /api/documents/inbound`) gives besides a
 * freshly stored row: the receipt a narrow token gets, a duplicate, a
 * re-send of a deleted import, the alias limit, and the size refusal.
 */
import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import type { SerialisableDocument } from "@/lib/documents/store";
import type { SourceKeyMatch } from "@/lib/documents/source-key";
import { duplicateDocumentBody } from "@/lib/documents/upload-answer";
import type { DocumentSourceSystemValue } from "@/lib/validations/inbound-documents";

/** §3.2 — 413 fileTooLarge with the configured limit in `meta`. */
export function fileTooLarge(maxFileBytes: number): NextResponse {
  return apiError("File is too large.", 413, {
    errorCode: "documents.inbound.fileTooLarge",
    reason: "fileTooLarge",
    maxFileBytes,
  });
}

/** What a single upload asked for, carried into the annotations. */
export interface UploadContext {
  userId: string;
  /** A narrow `documents:write` token, not a session or a `["*"]` token. */
  scoped: boolean;
  sourceSystem: DocumentSourceSystemValue | null;
  aiDeferred: boolean;
}

/**
 * The receipt a scoped caller gets in place of the stored row: the id and
 * whether the upload was a duplicate. A write-only credential holder who
 * knows a file's bytes learns that it is stored, not its title, filename,
 * links or fact counts.
 */
export function receiptResponse(
  id: string | null,
  status: 200 | 201,
  flags: { duplicate: boolean; deleted?: boolean },
): NextResponse {
  const data = {
    id,
    duplicate: flags.duplicate,
    ...(flags.deleted ? { deleted: true } : {}),
  };
  return NextResponse.json(
    {
      data,
      error: null,
      ...(flags.duplicate
        ? {
            meta: {
              duplicate: true,
              ...(flags.deleted ? { deleted: true } : {}),
            },
          }
        : {}),
    },
    { status },
  );
}

/**
 * A re-send of an imported document the person deleted.
 * 200 and no new row, for every caller: the deletion was a decision, and an
 * importer re-running over the same source must not undo it. `id` is the
 * tombstoned row while it exists and null once the purge took it; there is no
 * row left to serialise either way, so the answer is the receipt.
 */
export function deletedResponse(
  ctx: UploadContext,
  id: string | null,
): NextResponse {
  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: id,
      duplicate: true,
      deleted: true,
      scoped: ctx.scoped,
      sourceSystem: ctx.sourceSystem,
      aiDeferred: ctx.aiDeferred,
    },
  });
  return receiptResponse(id, 200, { duplicate: true, deleted: true });
}

/**
 * The same bytes have already been sent under too many source keys
 * (`MAX_SOURCE_ALIASES_PER_DOCUMENT`). A conflict with what is stored, not a
 * rate: nothing is remembered and nothing stored.
 */
export function aliasLimitResponse(): NextResponse {
  return apiError(
    "This file is already stored under too many source ids.",
    409,
    { errorCode: "documents.inbound.sourceAliasLimit" },
  );
}

/** Answer a source key that is already held: duplicate, or deleted. */
export function answerSourceKey(
  ctx: UploadContext,
  match: SourceKeyMatch,
): Promise<NextResponse> | NextResponse {
  return match.state === "live"
    ? duplicateResponse(ctx, match.document)
    : deletedResponse(ctx, match.id);
}

/**
 * §3.2 — a duplicate upload is NOT an error: return the existing live row
 * with `meta.duplicate: true` at the envelope level (the UI toasts "already
 * stored" and highlights the row). A scoped caller gets the receipt instead.
 */
export async function duplicateResponse(
  ctx: UploadContext,
  existing: SerialisableDocument,
): Promise<NextResponse> {
  annotate({
    action: { name: "documents.vault.upload" },
    meta: {
      documentId: existing.id,
      duplicate: true,
      scoped: ctx.scoped,
      sourceSystem: ctx.sourceSystem,
      aiDeferred: ctx.aiDeferred,
    },
  });
  if (ctx.scoped) {
    return receiptResponse(existing.id, 200, { duplicate: true });
  }
  return NextResponse.json(
    {
      data: await duplicateDocumentBody(ctx.userId, existing),
      error: null,
      meta: { duplicate: true },
    },
    { status: 200 },
  );
}
