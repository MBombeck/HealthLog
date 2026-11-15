/**
 * Every response this app streams as Server-Sent Events says
 * `Cache-Control: no-transform`.
 *
 * Next.js compresses route-handler responses for a client that accepts it
 * (since 16.4.6), and its compression middleware skips a response only when
 * the type is not compressible or `Cache-Control` carries `no-transform`.
 * `text/event-stream` is compressible, so without the directive a Coach or
 * document-chat stream would go out gzipped: every token a separate deflate
 * flush, and a proxy that buffers compressed bodies would hold the reply until
 * it ends. The directive is what keeps the stream as written.
 *
 * The guard finds the SSE surfaces by the content type they declare, so a new
 * one is covered without being listed, and it fails if it finds none, which
 * would mean the matcher went blind rather than that the surfaces went away.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** A `Content-Type` header literal (either quote style) naming SSE. */
const SSE_CONTENT_TYPE = /["']?content-type["']?\s*:\s*["']text\/event-stream/i;
/** A `Cache-Control` header literal whose value lists `no-transform`. */
const NO_TRANSFORM =
  /["']?cache-control["']?\s*:\s*["'][^"']*\bno-transform\b/i;

function sseSurfaces(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) =>
      SSE_CONTENT_TYPE.test(stripComments(readSourceText(join(SRC, p)), p)),
    )
    .sort();
}

describe("SSE responses opt out of compression", () => {
  it("finds the SSE surfaces it is meant to watch", () => {
    // The Coach turn and the fenced document chat today.
    const surfaces = sseSurfaces();
    expect(surfaces.length).toBeGreaterThanOrEqual(2);
    expect(surfaces).toEqual(
      expect.arrayContaining([
        "lib/ai/coach/turn/sse.ts",
        "lib/documents/fenced-chat.ts",
      ]),
    );
  });

  it("sets Cache-Control: no-transform wherever it declares text/event-stream", () => {
    const missing = sseSurfaces().filter(
      (p) => !NO_TRANSFORM.test(stripComments(readSourceText(join(SRC, p)), p)),
    );
    expect(missing).toEqual([]);
  });
});
