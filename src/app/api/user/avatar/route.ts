/**
 * v1.5.5 — self-hosted avatar storage.
 *
 *  POST   /api/user/avatar  — multipart upload, owner-scoped.
 *  DELETE /api/user/avatar  — clears the row, owner-scoped.
 *
 * Replaces the Gravatar third-party leak. The previous /me payload
 * carried a `gravatarUrl` built from `SHA-256(email)` and pointed
 * every authenticated page-load at www.gravatar.com — Automattic
 * could correlate the digest against its own known-email table on
 * each request. Storing the image bytes on the User row and serving
 * them from same-origin closes the gap without adding a filesystem
 * volume or a new compose change (pg_dump already carries the
 * bytes alongside the rest of the row).
 *
 * Validation:
 *   - Max body size: 2 MiB (small enough to keep the request pipeline
 *     responsive, big enough for a 512×512 JPEG).
 *   - Accepted MIME: image/jpeg, image/png, image/webp. Anything else
 *     fails 415.
 *   - The Content-Type sent by the multipart header is informational
 *     only — the route sniffs the magic bytes and refuses a mismatch.
 *   - The image is decoded just enough to read its native width +
 *     height; > 2048×2048 fails 413 so a single user cannot park a
 *     huge PNG in the database.
 *
 * Storage choice: image bytes on the User row (Postgres bytea). The
 * file alternative needs a new volume mount + a new compose change
 * + a separate backup story; the byte alternative slots into the
 * existing backup path with no operator change. Avatars stay small
 * (< 2 MiB hard cap × < 100 users on a typical self-host = < 200 MB
 * total), so the row-size trade-off is well inside budget.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import {
  AVATAR_MAX_BYTES,
  buildAvatarUrl,
  detectAvatarMimeType,
  readAvatarDimensions,
} from "@/lib/avatar";

export const dynamic = "force-dynamic";

/**
 * Per-user upload rate-limit. The Settings → Account avatar control
 * is a deliberate user action, not an automation surface, so a tight
 * cap (10 / hour / user) is comfortable for real flows and tripwires
 * a misbehaving client without surfacing as a 429 on a normal
 * re-upload.
 */
const UPLOAD_LIMIT_PER_HOUR = 10;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

interface UploadResponse {
  avatarUrl: string;
  contentType: string;
  updatedAt: string;
}

/** Thrown by `readBoundedBody` when the stream exceeds the byte cap. */
class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the configured byte cap");
    this.name = "BodyTooLargeError";
  }
}

/**
 * Read a request body stream into a single buffer while counting bytes,
 * throwing `BodyTooLargeError` the moment the running total passes
 * `maxBytes`. Bounds the work at the stream level so a chunked /
 * unbounded upload cannot park past the cap even when no `Content-Length`
 * header is present. The captured bytes are retained (capped at
 * `maxBytes`) so the caller can reconstruct `FormData` from them — this
 * reads the body exactly once, with no clone and no second parser racing
 * the same body, so a cap trip frees the allocation immediately instead
 * of leaving a native parse buffering the rest of an oversized upload.
 */
async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (overflow) continue;
      if (retained + value.byteLength > maxBytes) {
        // Past the cap. Drop everything retained so far and stop
        // retaining further chunks — memory stays bounded at the cap.
        // Keep draining the stream to its natural close rather than
        // cancelling it: an abrupt cancel mid-transfer races the
        // underlying (undici) producer, which then enqueues into a
        // closed controller and surfaces as an unhandled rejection.
        chunks.length = 0;
        retained = 0;
        overflow = true;
        continue;
      }
      chunks.push(value);
      retained += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (overflow) throw new BodyTooLargeError();
  const out = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export const POST = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `user-avatar-upload:${user.id}`,
    UPLOAD_LIMIT_PER_HOUR,
    UPLOAD_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many avatar uploads", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // Pre-flight on the declared content length so a multi-gigabyte
  // body never lands in the FormData parser. The hard limit below
  // is the buffered-size check; the header guard just spares the
  // allocation when the abuse is obvious.
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > AVATAR_MAX_BYTES) {
    annotate({
      action: { name: "user.avatar.upload.rejected" },
      meta: { reason: "content_length_exceeded", contentLength },
    });
    return apiError(
      `Upload exceeds ${AVATAR_MAX_BYTES} byte limit`,
      413,
    );
  }

  // Stream-level cap. The Content-Length pre-flight above only fires when
  // the header is present; a `Transfer-Encoding: chunked` upload (or any
  // client that omits the header) skips it, and `request.formData()`
  // would then buffer the whole stream before the post-parse `file.size`
  // check can run. Read the body ONCE through a bounded reader that
  // aborts on the first byte past AVATAR_MAX_BYTES, then reconstruct the
  // FormData from the captured bytes. A single read means the cap trip
  // frees the allocation immediately — no clone, no tee, and no native
  // parse left buffering the rest of an oversized body. The post-parse
  // `file.size` check stays in place as defence-in-depth.
  let formData: FormData;
  try {
    const bytes = await readBoundedBody(request.body, AVATAR_MAX_BYTES);
    formData = await new Response(new Blob([bytes]), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch (err) {
    // Surface the most useful failure: a cap overflow always wins.
    if (err instanceof BodyTooLargeError) {
      annotate({
        action: { name: "user.avatar.upload.rejected" },
        meta: { reason: "stream_size_exceeded" },
      });
      return apiError(`Upload exceeds ${AVATAR_MAX_BYTES} byte limit`, 413);
    }
    return apiError(
      `Invalid multipart body: ${err instanceof Error ? err.message : "unknown"}`,
      400,
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return apiError("Field 'file' must be a file", 422);
  }

  if (file.size > AVATAR_MAX_BYTES) {
    annotate({
      action: { name: "user.avatar.upload.rejected" },
      meta: { reason: "file_size_exceeded", size: file.size },
    });
    return apiError(
      `Upload exceeds ${AVATAR_MAX_BYTES} byte limit`,
      413,
    );
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("Failed to read uploaded file", 400);
  }

  // Magic-byte sniff. The multipart Content-Type header is operator-
  // controlled (any client can send `image/jpeg` over a PNG body), so
  // the wire-side header is informational only.
  const sniffed = detectAvatarMimeType(buffer);
  if (!sniffed) {
    annotate({
      action: { name: "user.avatar.upload.rejected" },
      meta: { reason: "unsupported_mime" },
    });
    return apiError(
      "Unsupported image type. Use JPEG, PNG, or WebP.",
      415,
    );
  }

  const dimensions = readAvatarDimensions(buffer, sniffed);
  if (!dimensions) {
    annotate({
      action: { name: "user.avatar.upload.rejected" },
      meta: { reason: "dimensions_unreadable" },
    });
    return apiError("Image dimensions could not be read", 422);
  }

  if (dimensions.width > 2048 || dimensions.height > 2048) {
    annotate({
      action: { name: "user.avatar.upload.rejected" },
      meta: {
        reason: "dimensions_exceeded",
        width: dimensions.width,
        height: dimensions.height,
      },
    });
    return apiError(
      `Image exceeds the 2048×2048 dimension limit`,
      413,
    );
  }

  const updatedAt = new Date();
  // Prisma's Bytes column types as `Uint8Array<ArrayBuffer>`; Node's
  // `Buffer` extends `Uint8Array` but is generic over
  // `ArrayBufferLike`. Allocating a fresh `Uint8Array(N).set(buffer)`
  // copies the bytes into an `ArrayBuffer`-backed array so the
  // structural assignment to the Prisma `Bytes?` field type-checks
  // cleanly.
  const avatarBytes = new Uint8Array(buffer.byteLength);
  avatarBytes.set(buffer);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      avatarBytes,
      avatarContentType: sniffed,
      avatarUpdatedAt: updatedAt,
    },
  });

  await auditLog("user.avatar.upload", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      contentType: sniffed,
      size: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
    },
  });

  annotate({
    action: { name: "user.avatar.upload" },
    meta: { contentType: sniffed, size: buffer.length },
  });

  const response: UploadResponse = {
    avatarUrl: buildAvatarUrl(user.id, updatedAt),
    contentType: sniffed,
    updatedAt: updatedAt.toISOString(),
  };
  return apiSuccess(response, 201);
});

export const DELETE = apiHandler(async (request: Request) => {
  const { user } = await requireAuth();

  // Only audit the actual clear so a "delete on an already-empty
  // row" is a no-op for the ledger. The DB write fires either way
  // for code simplicity; the size of the row delta is zero when the
  // columns were already null.
  const previous = await prisma.user.findUnique({
    where: { id: user.id },
    select: { avatarContentType: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      avatarBytes: null,
      avatarContentType: null,
      avatarUpdatedAt: null,
    },
  });

  if (previous?.avatarContentType) {
    await auditLog("user.avatar.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { previousContentType: previous.avatarContentType },
    });
  }

  annotate({ action: { name: "user.avatar.delete" } });

  return new Response(null, { status: 204 });
});
