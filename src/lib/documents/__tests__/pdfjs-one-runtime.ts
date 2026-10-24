/**
 * Shared steps for the two `pdfjs-one-runtime-*` files (GitHub #1277).
 *
 * Under Node, pdf.js runs its worker in-process and keeps it on
 * `globalThis.pdfjsWorker`. Whichever pdf.js copy opens a document first
 * owns that global for the life of the process, and a different copy then
 * refuses every document with "The API version … does not match the Worker
 * version …". The text reader and the rasterizer once loaded different
 * copies, so whichever ran first broke the other until a restart.
 *
 * Each order needs a fresh process, because the global cannot be taken back
 * once claimed; that is why the two orders live in two files (the isolated
 * project gives each file its own process) instead of two tests here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { extractPdfText } from "../local-extract";
import { rasterizePdf } from "../rasterize-pdf";

const FIXTURE = join(
  process.cwd(),
  "tests",
  "fixtures",
  "pdf",
  "fallback-fonts.pdf",
);

const pdf = () => readFileSync(FIXTURE);

/** Nothing in this process has opened a PDF yet. */
export function expectFreshProcess(): void {
  expect(
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker,
    "the file must run in its own process; another file already opened a PDF",
  ).toBeUndefined();
}

export async function expectTextRead(): Promise<void> {
  const result = await extractPdfText(pdf());
  expect(result).toMatchObject({ ok: true, source: "local-pdf" });
  if (result.ok) expect(result.text).toContain("Test Insurance AG");
}

export async function expectRaster(): Promise<void> {
  const result = await rasterizePdf(pdf(), 1);
  expect(result).toMatchObject({ ok: true });
}
