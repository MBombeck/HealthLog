// @ts-check
/**
 * Reading the text off one page image with tesseract, in the reader's child
 * process (`./pdf-child.mjs`, under the memory ceiling and the time limit of
 * `./pdf-isolation.ts`).
 *
 * The engine is tesseract.js, the WebAssembly Tesseract the lab scan runs in
 * the browser: no native code, nothing per CPU, and it runs on every machine
 * the image runs on (the Raspberry Pi 4 included). The image carries it as a
 * tree of its own (`scripts/stage-ocr-runtime.mjs`). The language data is
 * the `4.0.0_best_int` set the browser reads too, staged into
 * `public/tesseract/lang` by `scripts/stage-tesseract-assets.mjs` and read
 * from disk here; nothing is fetched. tesseract.js starts its engine in
 * a worker thread of this process, so the child's resident memory, which the
 * parent samples, covers it.
 *
 * Plain JavaScript for the same reason as `./pdf-engine.mjs`: the child runs
 * it with plain Node from the checkout and the standalone image alike.
 */
import { Buffer } from "node:buffer";

/** tesseract's LSTM engine, the only one the shipped core builds contain. */
const OEM_LSTM_ONLY = 1;

/**
 * @typedef {object} OcrOptions
 * @property {string[]} languages Language data names, `deu` and `eng` first.
 * @property {string} langPath The directory holding `<language>.traineddata.gz`.
 * @property {number} [dpi] The resolution the page was rendered at, when known.
 */

/**
 * @typedef {object} OcrPageText
 * @property {string} text The page's text, line by line, columns kept as runs of spaces.
 * @property {number} confidence tesseract's mean word confidence, 0 to 100.
 */

/**
 * The slice of tesseract.js used here; the suites pass a stand-in.
 *
 * @typedef {object} TesseractModule
 * @property {(langs: string[], oem: number, options: Record<string, unknown>) => Promise<{
 *   setParameters(params: Record<string, string>): Promise<unknown>;
 *   recognize(image: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
 *   terminate(): Promise<unknown>;
 * }>} createWorker
 */

/**
 * Recognise the text of one page image (JPEG, PNG or WebP). Throws what the
 * engine threw.
 *
 * Interword spaces are preserved: a lab report is a table, and the runs of
 * spaces between its columns are what tells a value from the analyte name
 * before it and the range after it.
 *
 * @param {Uint8Array} data
 * @param {OcrOptions} options
 * @param {TesseractModule} [tesseractModule]
 * @returns {Promise<OcrPageText>}
 */
export async function recognizePage(data, options, tesseractModule) {
  const tesseract =
    tesseractModule ??
    /** @type {TesseractModule} */ (
      /** @type {{ default: unknown }} */ (await import("tesseract.js")).default
    );
  const worker = await tesseract.createWorker(
    options.languages,
    OEM_LSTM_ONLY,
    {
      langPath: options.langPath,
      // Read from disk on every start, never written back: the app directory
      // is not writable in the image, and a cache there would be a second
      // copy of what is already on disk.
      cacheMethod: "none",
      gzip: true,
    },
  );
  try {
    await worker.setParameters({
      preserve_interword_spaces: "1",
      ...(options.dpi
        ? { user_defined_dpi: String(Math.round(options.dpi)) }
        : {}),
    });
    const { data: out } = await worker.recognize(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    );
    return {
      text: typeof out.text === "string" ? out.text : "",
      confidence: typeof out.confidence === "number" ? out.confidence : 0,
    };
  } finally {
    await worker.terminate();
  }
}
