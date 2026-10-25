/**
 * v1.5.5 — avatar helpers shared by the /api/user/avatar routes and
 * the /api/auth/me profile response.
 *
 * Self-hosted replacement for the Gravatar third-party leak. The
 * helpers stay independent of any image-processing dependency: the
 * MIME sniff reads the magic bytes, and the dimension probe walks
 * the format's header bytes by hand. Adding a heavyweight image
 * library (sharp / jimp) would pull a native dependency into the
 * Alpine standalone image just to read width + height — the hand-
 * rolled parser lives in `./image-dimensions` and covers JPEG / PNG / WebP.
 */
import { readImageDimensions, type ImageDimensions } from "./image-dimensions";

/** Hard upload cap. 2 MiB is comfortable for a 512×512 JPEG. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Allowed content-type values, in canonical lower-case form. */
export const ALLOWED_AVATAR_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AvatarMime = (typeof ALLOWED_AVATAR_MIMES)[number];

/**
 * Sniff the MIME from the buffer's magic bytes. The multipart
 * Content-Type header is operator-controlled (any client can send
 * `image/jpeg` over a PNG body), so the wire-side header is
 * informational only — the sniff is the source of truth.
 *
 * Returns `null` for an unsupported / unrecognised format.
 */
export function detectAvatarMimeType(buffer: Buffer): AvatarMime | null {
  if (buffer.length < 12) return null;

  // JPEG — FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP — "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export type AvatarDimensions = ImageDimensions;

/**
 * Read the native image dimensions from the header bytes, without a
 * decode (`readImageDimensions`, shared with the document thumbnail).
 * Returns `null` when the buffer is truncated or the format header is
 * malformed; the caller maps that to a 422.
 */
export function readAvatarDimensions(
  buffer: Buffer,
  mime: AvatarMime,
): AvatarDimensions | null {
  return readImageDimensions(buffer, mime);
}

/**
 * Build the cache-busting avatar URL the /me payload returns. The
 * `?v={updatedAtMs}` suffix lets the client cache aggressively
 * while keeping a re-upload visible on the next paint.
 */
export function buildAvatarUrl(userId: string, updatedAt: Date): string {
  return `/api/user/avatar/${userId}?v=${updatedAt.getTime()}`;
}
