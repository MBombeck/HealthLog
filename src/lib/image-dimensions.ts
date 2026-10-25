/**
 * An image's declared width and height, read from its container header
 * without decoding it.
 *
 * Two places depend on this. The avatar upload refuses anything larger than
 * it serves, and the document thumbnail refuses to decode a source past its
 * pixel cap, because the decoder allocates the full bitmap before anything
 * can look at it. Both treat `null` as a refusal: a decoder reads headers
 * more leniently than a hand-written walker, so "could not read the size" is
 * no evidence the size is small.
 *
 * There used to be two walkers. The thumbnail's took the byte after any 0xFF
 * as a marker, so a single fill byte after the start-of-image marker, which
 * the JPEG standard allows and every decoder skips, threw it off; it answered
 * `null`, and `null` let the image through to a decode of 20000 x 20000
 * pixels. This is the one walker now.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

export type DimensionedImageMime =
  "image/jpeg" | "image/png" | "image/webp" | "image/gif";

/**
 * The declared size, or `null` when the header is truncated, malformed, or
 * declares a zero side. Never throws.
 */
export function readImageDimensions(
  bytes: Buffer,
  mime: DimensionedImageMime,
): ImageDimensions | null {
  try {
    const size = readBySniffedType(bytes, mime);
    if (!size || size.width <= 0 || size.height <= 0) return null;
    return size;
  } catch {
    return null;
  }
}

function readBySniffedType(
  bytes: Buffer,
  mime: DimensionedImageMime,
): ImageDimensions | null {
  switch (mime) {
    case "image/png":
      return readPng(bytes);
    case "image/jpeg":
      return readJpeg(bytes);
    case "image/webp":
      return readWebp(bytes);
    case "image/gif":
      return readGif(bytes);
  }
}

function readPng(bytes: Buffer): ImageDimensions | null {
  // 8-byte signature + 4-byte chunk length + "IHDR" + width + height.
  if (bytes.length < 24) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readGif(bytes: Buffer): ImageDimensions | null {
  // "GIF87a" / "GIF89a", then the logical screen: width, height (LE).
  if (bytes.length < 10 || bytes.toString("ascii", 0, 4) !== "GIF8") {
    return null;
  }
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/**
 * Walk the marker segments to the first Start Of Frame (ITU-T T.81, B.1.1).
 * A marker is 0xFF followed by a byte that is neither 0x00 nor 0xFF; any
 * number of 0xFF fill bytes may come before it. SOI, EOI, RST0-7 and TEM
 * carry no length. A scan or the end of the image before any frame header
 * means there is no size to read.
 */
function readJpeg(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset]!;
    offset++;

    if (marker === 0x00) return null; // a stuffed byte outside entropy data
    if (marker === 0xd8 || marker === 0x01) continue; // SOI, TEM
    if (marker >= 0xd0 && marker <= 0xd7) continue; // RST0-7
    if (marker === 0xd9 || marker === 0xda) return null; // EOI, SOS

    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2) return null;

    // SOF0-15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      // length (2) | precision (1) | height (2) | width (2)
      if (offset + 7 > bytes.length) return null;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function readWebp(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  if (bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const fourCc = bytes.toString("ascii", 12, 16);

  if (fourCc === "VP8 ") {
    // Lossy: 14-bit width and height (LE) in the frame header.
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourCc === "VP8L") {
    // Lossless: signature 0x2f, then width-1 and height-1 in 14 bits each.
    if (bytes[20] !== 0x2f) return null;
    const packed = bytes.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  if (fourCc === "VP8X") {
    // Extended: the canvas, width-1 and height-1 in 24 bits each (LE).
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  return null;
}
