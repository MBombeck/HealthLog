import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * OCR on the server, end to end: the real renderer and the real tesseract in
 * the reader's child process, on a synthetic scan. Then the bounds and the
 * answers around it with a stand-in child: a page past its limit, a busy
 * reader, a job that was aborted, a document that went away.
 */

const { annotate } = vi.hoisted(() => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate }));

import { locales } from "@/lib/i18n/config";

import { PdfReaderUnavailableError } from "../pdfjs";
import {
  __resetServerOcrStatusForTests,
  readLanguages,
  readScanText,
  serverOcrStatus,
} from "../server-ocr";
import { localExtractText } from "../local-extract";
import {
  syntheticLabScanJpeg,
  syntheticLabScanPdf,
  syntheticScriptScanJpeg,
} from "./synthetic-scan";

const require = createRequire(import.meta.url);
let langDir: string;

/** Every language the build stages, in the order the status lists them. */
const LANGUAGES = [
  "deu",
  "eng",
  "fra",
  "spa",
  "ita",
  "pol",
  "nld",
  "por",
  "rus",
  "kor",
];

beforeAll(() => {
  // The language data the build stages into `public/tesseract/lang`, staged
  // here into a directory of the suite's own.
  langDir = mkdtempSync(join(tmpdir(), "hl-ocr-lang-"));
  for (const lang of LANGUAGES) {
    const manifest = require.resolve(`@tesseract.js-data/${lang}/package.json`);
    copyFileSync(
      join(dirname(manifest), "4.0.0_best_int", `${lang}.traineddata.gz`),
      join(langDir, `${lang}.traineddata.gz`),
    );
  }
  __resetServerOcrStatusForTests(langDir);
});

afterAll(() => {
  __resetServerOcrStatusForTests();
  rmSync(langDir, { recursive: true, force: true });
});

describe("serverOcrStatus", () => {
  it("finds the engine and the staged languages, German first", () => {
    expect(serverOcrStatus()).toEqual({
      available: true,
      languages: LANGUAGES,
    });
  });

  it("says when the build carries no language data", () => {
    const empty = mkdtempSync(join(tmpdir(), "hl-ocr-none-"));
    try {
      __resetServerOcrStatusForTests(empty);
      expect(serverOcrStatus()).toEqual({
        available: false,
        reason: "languages-missing",
      });
    } finally {
      __resetServerOcrStatusForTests(langDir);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("readLanguages", () => {
  it("reads German and English, plus the account's own language", () => {
    expect(readLanguages(LANGUAGES, null)).toEqual(["deu", "eng"]);
    expect(readLanguages(LANGUAGES, "de")).toEqual(["deu", "eng"]);
    expect(readLanguages(LANGUAGES, "en")).toEqual(["deu", "eng"]);
    expect(readLanguages(LANGUAGES, "ru")).toEqual(["deu", "eng", "rus"]);
    expect(readLanguages(LANGUAGES, "ko")).toEqual(["deu", "eng", "kor"]);
    expect(readLanguages(LANGUAGES, "pt-BR")).toEqual(["deu", "eng", "por"]);
  });

  it("has data for every app locale", () => {
    for (const locale of locales) {
      expect(readLanguages(LANGUAGES, locale).length).toBe(
        locale === "de" || locale === "en" ? 2 : 3,
      );
    }
  });

  it("leaves out what the build does not carry, and an unknown locale", () => {
    expect(readLanguages(["deu", "eng"], "ru")).toEqual(["deu", "eng"]);
    expect(readLanguages(LANGUAGES, "xx")).toEqual(["deu", "eng"]);
    expect(readLanguages(["rus"], "ko")).toEqual(["rus"]);
    expect(readLanguages([], "ru")).toEqual([]);
  });
});

describe("readScanText with the real engine", () => {
  it("reads a photo of a lab report", async () => {
    const result = await readScanText(syntheticLabScanJpeg(), "image/jpeg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(/Natrium\s+141\s+mmol\/l\s+135 - 145/u);
    expect(result.text).toMatch(/Kreatinin\s+1,08\s+mg\/dl/u);
    expect(result.text).toContain("03.11.2026");
    expect(result.pagesRead).toBe(1);
    expect(result.confidence).toBeGreaterThan(60);
  }, 120_000);

  it("reads a scanned PDF that has no text layer, page by page", async () => {
    const pdf = syntheticLabScanPdf(2);
    const result = await readScanText(pdf, "application/pdf");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pagesRead).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.text.match(/Natrium\s+141\s+mmol\/l/gu)?.length).toBe(2);
  }, 180_000);

  it("indexes a scanned PDF as local-ocr where the text layer is empty", async () => {
    const result = await localExtractText(
      syntheticLabScanPdf(),
      "application/pdf",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("local-ocr");
      // OCR may drop the umlaut; the catalog match folds it either way.
      expect(result.text).toMatch(/H.moglobin\s+14,6/u);
    }
  }, 120_000);
});

describe("readScanText in the account's language", () => {
  it("reads a Russian scan for an account in Russian", async () => {
    const result = await readScanText(
      syntheticScriptScanJpeg("ru"),
      "image/jpeg",
      { locale: async () => "ru" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Гемоглобин");
    expect(result.text).toMatch(/Глюкоза\s+5,4\s+ммоль\/л/u);
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "documents.localOcr.read" },
        meta: expect.objectContaining({ languages: "deu+eng+rus" }),
      }),
    );
  }, 120_000);

  it("reads a Korean scan for an account in Korean", async () => {
    const result = await readScanText(
      syntheticScriptScanJpeg("ko"),
      "image/jpeg",
      { locale: async () => "ko" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.replace(/\s+/gu, "")).toContain("헤모글로빈14.6");
    expect(result.text.replace(/\s+/gu, "")).toContain("포도당5.4");
  }, 120_000);

  it("reads Cyrillic only when the account's language brings it", async () => {
    const result = await readScanText(
      syntheticScriptScanJpeg("ru"),
      "image/jpeg",
      { locale: async () => "de" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("Гемоглобин");
  }, 120_000);
});

describe("readScanText around the engine", () => {
  const page = { text: "Natrium 141 mmol/l 135 - 145", confidence: 90 };

  it("answers failed when every page crosses its limit", async () => {
    const result = await readScanText(syntheticLabScanJpeg(), "image/jpeg", {
      run: async (_script, request) =>
        request.op === "ocr"
          ? { ok: false, reason: "limit", limit: "time" }
          : {
              ok: true,
              value: {
                ok: true,
                jpeg: new Uint8Array([1]),
                width: 1,
                height: 1,
              },
            },
    });
    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("runs the job again when the reader is busy", async () => {
    await expect(
      readScanText(syntheticLabScanJpeg(), "image/jpeg", {
        run: async () => ({ ok: false, reason: "interrupted" }),
      }),
    ).rejects.toBeInstanceOf(PdfReaderUnavailableError);
  });

  it("stops between pages once the document is gone", async () => {
    const reads: string[] = [];
    const result = await readScanText(
      syntheticLabScanPdf(3),
      "application/pdf",
      {
        stillWanted: async () => reads.length < 1,
        run: async (_script, request) => {
          if (request.op === "render") {
            return {
              ok: true,
              value: {
                pageCount: 3,
                assetsMissing: false,
                pages: [1, 2, 3].map(() => ({
                  jpeg: Buffer.from([1]),
                  blank: false,
                })),
              },
            };
          }
          reads.push(request.op);
          return { ok: true, value: page };
        },
      },
    );
    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(reads).toEqual(["ocr"]);
  });

  it("answers cancelled when the job was aborted before its turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await readScanText(syntheticLabScanJpeg(), "image/jpeg", {
      signal: controller.signal,
      run: async () => {
        throw new Error("no child may start");
      },
    });
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("indexes no text from a read that is noise", async () => {
    const thumbnail = {
      ok: true as const,
      value: {
        ok: true as const,
        jpeg: new Uint8Array([1]),
        width: 1,
        height: 1,
      },
    };
    const read = (confidence: number) =>
      localExtractText(syntheticLabScanJpeg(), "image/jpeg", {
        run: async (_script, request) =>
          request.op === "ocr"
            ? {
                ok: true,
                value: {
                  text: "ii ,. l1 ~ ' rn . il ;; ' 1l ,,. ~ ii l .",
                  confidence,
                },
              }
            : thumbnail,
      });
    expect(await read(12)).toEqual({ ok: false, reason: "empty" });
    expect(await read(88)).toMatchObject({ ok: true, source: "local-ocr" });
  });

  it("leaves a type tesseract cannot decode unread", async () => {
    const result = await readScanText(Buffer.from("GIF89a"), "image/gif");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
