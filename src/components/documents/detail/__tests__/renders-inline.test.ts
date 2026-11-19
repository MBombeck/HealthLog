import { describe, expect, it } from "vitest";

import { rendersInline } from "../original-file";

/**
 * #1403 — on Chrome for Android the PDF preview frame painted "This content
 * is blocked": the browser has no in-page PDF viewer, so the frame's PDF
 * went down the download path, which a plain-http origin refuses. A PDF is
 * drawn in the sheet only where the browser reports a viewer.
 */
const pdf = { servingClass: "inline", mimeType: "application/pdf" };
const png = { servingClass: "inline", mimeType: "image/png" };
const docx = {
  servingClass: "attachment",
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

describe("rendersInline", () => {
  it("draws a PDF where the browser has a PDF viewer", () => {
    expect(rendersInline(pdf, true)).toBe(true);
  });

  it("does not frame a PDF where the browser has none", () => {
    expect(rendersInline(pdf, false)).toBe(false);
  });

  it("keeps images inline whatever the PDF viewer says", () => {
    expect(rendersInline(png, false)).toBe(true);
  });

  it("never draws an attachment-class type", () => {
    expect(rendersInline(docx, true)).toBe(false);
  });
});
