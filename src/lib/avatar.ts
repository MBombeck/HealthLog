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
 * rolled parser is < 100 LOC and covers JPEG / PNG / WebP.
 */

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
  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
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

export interface AvatarDimensions {
  width: number;
  height: number;
}

/**
 * Read the native image dimensions from the header bytes. Each
 * format encodes width + height at a fixed offset in the leading
 * chunks, so a full decode is unnecessary:
 *
 *   - PNG: IHDR chunk after the 8-byte signature; width at offset
 *     16, height at offset 20, both big-endian 32-bit unsigned.
 *   - JPEG: walk the marker segments until the first SOFn (Start
 *     Of Frame) marker, then read the two big-endian 16-bit values
 *     at marker offset + 5 (height) and + 7 (width).
 *   - WebP: three sub-formats (VP8 / VP8L / VP8X); each pins
 *     width-1 and height-1 at known offsets in the leading chunk.
 *
 * Returns `null` when the buffer is truncated or the format header
 * is malformed; the caller maps that to a 422.
 */
export function readAvatarDimensions(
  buffer: Buffer,
  mime: AvatarMime,
): AvatarDimensions | null {
  switch (mime) {
    case "image/png":
      return readPngDimensions(buffer);
    case "image/jpeg":
      return readJpegDimensions(buffer);
    case "image/webp":
      return readWebpDimensions(buffer);
  }
}

function readPngDimensions(buffer: Buffer): AvatarDimensions | null {
  // 8-byte signature + 4-byte chunk length + "IHDR" + 4-byte width
  // + 4-byte height = first valid read at offset 16.
  if (buffer.length < 24) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readJpegDimensions(buffer: Buffer): AvatarDimensions | null {
  // SOI marker (FF D8) confirmed by `detectAvatarMimeType`. Walk
  // the marker segments until the first SOFn (Start Of Frame)
  // marker (FF C0 .. FF C3, FF C5 .. FF C7, FF C9 .. FF CB, FF CD ..
  // FF CF). Every other marker carries a 16-bit length we can skip.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    // Skip any fill bytes (FF FF ...)
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) return null;
    const marker = buffer[offset];
    offset += 1;

    // Standalone markers without a payload.
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;

    if (offset + 7 >= buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2) return null;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof) {
      // The SOF payload layout is:
      //   length (2) | precision (1) | height (2) | width (2) | ...
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): AvatarDimensions | null {
  // RIFF / WEBP confirmed by `detectAvatarMimeType`. The chunk at
  // offset 12 is one of:
  //   "VP8 " — lossy
  //   "VP8L" — lossless
  //   "VP8X" — extended
  if (buffer.length < 30) return null;
  const fourCc = buffer.toString("ascii", 12, 16);

  if (fourCc === "VP8 ") {
    // VP8 frame header. Width/height live at chunk-payload offset
    // 6 / 8 as 14-bit values (bottom 14 bits of a 16-bit field).
    if (buffer.length < 30) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  if (fourCc === "VP8L") {
    // VP8L header: 1-byte signature (0x2f) + 4-byte packed dims.
    // width-1 = 14 low bits of the 32-bit little-endian word;
    // height-1 = the next 14 bits.
    if (buffer.length < 25) return null;
    if (buffer[20] !== 0x2f) return null;
    const packed = buffer.readUInt32LE(21);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  if (fourCc === "VP8X") {
    // VP8X chunk: 1-byte flags + 3-byte reserved + 3-byte canvas
    // width-1 + 3-byte canvas height-1 (all little-endian, padded
    // to 24 bits).
    if (buffer.length < 30) return null;
    const widthMinusOne =
      buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const heightMinusOne =
      buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);
    const width = widthMinusOne + 1;
    const height = heightMinusOne + 1;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }

  return null;
}

/**
 * Build the cache-busting avatar URL the /me payload returns. The
 * `?v={updatedAtMs}` suffix lets the client cache aggressively
 * while keeping a re-upload visible on the next paint.
 */
export function buildAvatarUrl(userId: string, updatedAt: Date): string {
  return `/api/user/avatar/${userId}?v=${updatedAt.getTime()}`;
}
