// @ts-check
/**
 * The process a PDF is read and rendered in, and an uploaded image is decoded
 * into its thumbnail in. `./pdf-isolation.ts` starts it for one request,
 * hands it the bytes over the IPC channel, and takes back either the result
 * or the fact that it died. It holds no secrets: it is started with an almost
 * empty environment and never opens the database.
 *
 * On Linux it volunteers itself to the kernel's out-of-memory killer first,
 * so when a document outruns the memory check between two samples and the
 * container hits its limit, the kernel takes this process rather than the
 * server.
 */
import { writeFileSync } from "node:fs";
import * as nodeModule from "node:module";

import { renderImageThumbnail } from "./image-engine.mjs";
import { readPageTexts, readTextLayer, renderPdfPages } from "./pdf-engine.mjs";

// The parent closed the canvas gate (`./native-canvas-support.ts`): this CPU
// lacks instructions the native canvas was built with, and loading it ends
// the process with SIGILL, which no try/catch sees. pdf.js asks for it the
// moment it starts and gets on without it when the load throws, so the text
// layer still reads; rendering and image thumbnails answer an error. Both
// engines load pdf.js and the canvas lazily, so this runs before either.
// `registerHooks` arrived in Node 22.15; the image ships a later one.
if (process.env.NATIVE_CANVAS === "off") {
  nodeModule.registerHooks?.({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@napi-rs/canvas") {
        throw new Error("@napi-rs/canvas is not supported on this CPU");
      }
      return nextResolve(specifier, context);
    },
  });
}

try {
  writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {
  // Not Linux, or not permitted: the parent's memory check still applies.
}

/**
 * @typedef {{ op: "text"; data: Uint8Array; maxPages: number }
 *   | { op: "page-texts"; data: Uint8Array; maxPages: number }
 *   | { op: "render"; data: Uint8Array; options: import("./pdf-engine.mjs").RenderOptions }
 *   | { op: "image-thumbnail"; data: Uint8Array; options: import("./image-engine.mjs").ImageThumbnailOptions }} PdfChildRequest
 */

/**
 * @param {unknown} err
 * @returns {{ ok: false; error: { name: string; message: string } }}
 */
function failure(err) {
  return {
    ok: false,
    error: {
      name: err instanceof Error ? err.name || "Error" : typeof err,
      message: err instanceof Error ? err.message.slice(0, 300) : String(err),
    },
  };
}

/** @param {PdfChildRequest} request */
async function handle(request) {
  try {
    const data = new Uint8Array(request.data);
    if (request.op === "text") {
      return { ok: true, text: await readTextLayer(data, request.maxPages) };
    }
    if (request.op === "page-texts") {
      return {
        ok: true,
        pageTexts: await readPageTexts(data, request.maxPages),
      };
    }
    if (request.op === "render") {
      return {
        ok: true,
        document: await renderPdfPages(data, request.options),
      };
    }
    if (request.op === "image-thumbnail") {
      return {
        ok: true,
        thumbnail: await renderImageThumbnail(data, request.options),
      };
    }
    return failure(new Error("unknown request"));
  } catch (err) {
    return failure(err);
  }
}

process.once("message", (message) => {
  void handle(/** @type {PdfChildRequest} */ (message)).then((reply) => {
    const send = process.send;
    if (!send) process.exit(1);
    send.call(process, reply, undefined, {}, () => process.exit(0));
  });
});
