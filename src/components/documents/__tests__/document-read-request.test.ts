import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { documentReadRequest } from "@/components/documents/detail/use-document-detail-ai";

/**
 * The sheet offered a summary twice: the summary block stored its paragraph,
 * the action row's "Summarise" asked the same route for a session-only copy
 * and lost it on close. Both now ask through one function.
 */
describe("documentReadRequest", () => {
  it("stores a summary on the document", () => {
    expect(documentReadRequest("summary", false)).toEqual({
      output: "summary",
      persist: true,
      replace: false,
    });
  });

  it("replaces a stored summary instead of adding a second one", () => {
    expect(documentReadRequest("summary", true)).toEqual({
      output: "summary",
      persist: true,
      replace: true,
    });
  });

  it("keeps the extracted text session-only", () => {
    expect(documentReadRequest("text", true)).toEqual({
      output: "text",
      persist: false,
      replace: false,
    });
  });
});
