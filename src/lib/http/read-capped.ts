/**
 * Bounded body reader (M3).
 *
 * `await res.text()` / `await request.text()` buffer the WHOLE body before any
 * size check runs, so a hostile peer can stream (or decompress) gigabytes into
 * memory for the duration of the request timeout before a post-hoc
 * `raw.length > MAX` rejection fires. This helper enforces the cap WHILE
 * reading: it rejects up front on an oversized `Content-Length`, then streams
 * the body and aborts the moment the running byte count exceeds the ceiling.
 *
 * Returns `{ ok: false }` on overflow (the caller maps it to its own error);
 * returns the decoded UTF-8 text on success. `readBodyBytesCapped` is the
 * same read for a binary body (an activity file download).
 */
export type CappedReadResult =
  { ok: true; text: string } | { ok: false; reason: "too_large" };

export type CappedBytesResult =
  { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" };

type CappedSource = {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

export async function readBodyCapped(
  source: CappedSource,
  maxBytes: number,
): Promise<CappedReadResult> {
  const read = await readBodyBytesCapped(source, maxBytes);
  if (!read.ok) return read;
  return { ok: true, text: new TextDecoder("utf-8").decode(read.bytes) };
}

export async function readBodyBytesCapped(
  source: CappedSource,
  maxBytes: number,
): Promise<CappedBytesResult> {
  // Up-front reject on a declared oversized length — cheap and stops the read
  // before a single byte is buffered.
  const declared = source.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      return { ok: false, reason: "too_large" };
    }
  }

  const body = source.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling immediately — do not buffer past the ceiling.
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}
