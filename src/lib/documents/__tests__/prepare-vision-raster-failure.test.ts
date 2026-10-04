import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Refs #776 — the raster-failed chain, end to end through the REAL
 * rasterizer: a PDF that pdfjs cannot open must surface as
 * `{ ok: false, reason: "rasterFailed" }` from `prepareVisionInput` (for an
 * image-only provider), which the index tree records as
 * `lastIndexOutcome: "raster-failed"` — never silently, never mislabelled as
 * "needs Anthropic".
 *
 * Fixture note (deliberate abstention, verified 2026-08-13): the reporter's
 * residual scan is a CCITT Group 4 (`/CCITTFaxDecode`, `/K -1`) single-image
 * PDF — a codec class pdfjs rasterization is known to fail on. A minimal
 * programmatically generated CCITT-G4 PDF was probed against THIS repo's
 * pdfjs: it renders the page as blank (`ok: true`, 1 page) rather than
 * throwing, because pdfjs skips the undecodable image object — so a tiny
 * in-repo CCITT fixture cannot deterministically go red on this version and
 * would be flaky across pdfjs upgrades. The deterministic stand-in below (a
 * PDF magic header over an unparseable body) exercises the same failure arm:
 * pdfjs throws at open, `rasterizePdf` reports `render-failed` (with the
 * pdfjs error text annotated), and the mapping to `rasterFailed` is what the
 * outcome column persists.
 */

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(),
}));

import { prepareVisionInput } from "../ai-route-support";
import { rasterizePdf } from "../rasterize-pdf";
import { decryptDocumentContent } from "@/lib/documents/store";

/** PDF magic bytes over a body pdfjs cannot parse. */
const UNRENDERABLE_PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256)),
]);

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
};

describe("raster-failed end to end (#776)", () => {
  it("rasterizePdf reports render-failed for a PDF pdfjs cannot open", async () => {
    const result = await rasterizePdf(UNRENDERABLE_PDF);
    expect(result).toEqual({ ok: false, reason: "render-failed" });
  });

  it("prepareVisionInput maps it to rasterFailed for an image-only provider", async () => {
    vi.mocked(decryptDocumentContent).mockReturnValue(
      UNRENDERABLE_PDF as never,
    );
    // pdfSupported=false → the raster path runs for real.
    const vision = await prepareVisionInput(DOC as never, false);
    expect(vision).toEqual({ ok: false, reason: "rasterFailed" });
  });

  it("a PDF-capable provider never rasterizes, so the same bytes stay readable natively", async () => {
    vi.mocked(decryptDocumentContent).mockReturnValue(
      UNRENDERABLE_PDF as never,
    );
    const vision = await prepareVisionInput(DOC as never, true);
    expect(vision).toMatchObject({ ok: true });
  });

  it("a PDF whose pages all render blank is rasterFailed, not an image of nothing (#1124)", async () => {
    // Text in render mode 3 only: pdfjs opens it and draws an empty page.
    // Before the blank-page guard this went to the provider as one white
    // JPEG and came back as a near-empty transcript indexed as a success.
    vi.mocked(decryptDocumentContent).mockReturnValue(
      readFileSync(
        join(process.cwd(), "tests/fixtures/pdf/invisible-text-only.pdf"),
      ) as never,
    );
    const vision = await prepareVisionInput(DOC as never, false);
    expect(vision).toEqual({ ok: false, reason: "rasterFailed" });
  });
});
