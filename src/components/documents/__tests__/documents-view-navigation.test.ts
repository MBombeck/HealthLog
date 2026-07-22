import { describe, expect, it } from "vitest";

import {
  closeDocumentSelectionHistoryEntry,
  closeDocumentSelectionAfterCoachHandoff,
  documentSelectionHistoryState,
  documentSelectionHref,
  withoutDocumentSelectionHref,
} from "../documents-view";

class MemoryHistory {
  private entries: { href: string; state: unknown }[];
  private index: number;

  constructor(entries: string[]) {
    this.entries = entries.map((href) => ({ href, state: null }));
    this.index = entries.length - 1;
  }

  get href() {
    return this.entries[this.index]?.href;
  }

  get state() {
    return this.entries[this.index]?.state;
  }

  pushState(state: unknown, _unused: string, href: string | URL) {
    this.entries.splice(this.index + 1, Infinity, {
      href: href.toString(),
      state,
    });
    this.index += 1;
  }

  replaceState(state: unknown, _unused: string, href?: string | URL | null) {
    this.entries[this.index] = {
      href: href?.toString() ?? this.href!,
      state,
    };
  }

  back() {
    if (this.index > 0) this.index -= 1;
  }
}

describe("document vault URL selection", () => {
  it("adds an ordinary card selection without dropping unrelated query state", () => {
    expect(
      documentSelectionHref(
        "/documents",
        "episode=episode-1&view=compact&q=MRT",
        "doc_123",
      ),
    ).toBe("/documents?episode=episode-1&view=compact&q=MRT&doc=doc_123");
  });

  it("replaces an existing selection instead of appending a duplicate", () => {
    expect(
      documentSelectionHref(
        "/documents",
        "episode=episode-1&doc=old-document",
        "new-document",
      ),
    ).toBe("/documents?episode=episode-1&doc=new-document");
  });

  it.each(["", "../coach", "doc?id=other", "doc id", "doc\n", "a".repeat(41)])(
    "refuses to write an unsafe document id: %j",
    (documentId) => {
      expect(
        documentSelectionHref(
          "/documents",
          "episode=episode-1&view=compact",
          documentId,
        ),
      ).toBeNull();
    },
  );

  it("removes only the document selection on close", () => {
    expect(
      withoutDocumentSelectionHref(
        "/documents",
        "episode=episode-1&doc=doc_123&view=compact&q=MRT",
      ),
    ).toBe("/documents?episode=episode-1&view=compact&q=MRT");
  });

  it("returns the pathname when doc was the only query parameter", () => {
    expect(withoutDocumentSelectionHref("/documents", "doc=doc_123")).toBe(
      "/documents",
    );
  });

  it("consumes a card-open entry so the next Back reaches the prior distinct page", () => {
    const history = new MemoryHistory(["/today", "/documents?episode=ep-1"]);
    const openHref = documentSelectionHref(
      "/documents",
      "episode=ep-1",
      "doc-1",
    );
    expect(openHref).not.toBeNull();
    history.pushState(documentSelectionHistoryState("doc-1"), "", openHref!);

    closeDocumentSelectionHistoryEntry(
      history,
      "/documents",
      "episode=ep-1&doc=doc-1",
      "doc-1",
    );

    expect(history.href).toBe("/documents?episode=ep-1");
    history.back();
    expect(history.href).toBe("/today");
  });

  it("consumes a dismissed Coach handoff and closes its card-owned detail entry", () => {
    const history = new MemoryHistory(["/today", "/documents?episode=ep-1"]);
    history.pushState(
      documentSelectionHistoryState("doc-1"),
      "",
      "/documents?episode=ep-1&doc=doc-1",
    );

    const retainedHandoff = closeDocumentSelectionAfterCoachHandoff(
      history,
      "/documents",
      "episode=ep-1&doc=doc-1",
      "doc-1",
      "doc-1",
      "dismiss",
    );

    expect(retainedHandoff).toBeNull();
    expect(history.href).toBe("/documents?episode=ep-1");
  });

  it("retains a navigating Coach handoff for maximize and browser Back", () => {
    const history = new MemoryHistory(["/today", "/documents?episode=ep-1"]);
    history.pushState(
      documentSelectionHistoryState("doc-1"),
      "",
      "/documents?episode=ep-1&doc=doc-1",
    );

    const retainedHandoff = closeDocumentSelectionAfterCoachHandoff(
      history,
      "/documents",
      "episode=ep-1&doc=doc-1",
      "doc-1",
      "doc-1",
      "navigate",
    );

    expect(retainedHandoff).toBe("doc-1");
    expect(history.href).toBe("/documents?episode=ep-1&doc=doc-1");
  });

  it("replaces a direct deep-link selection without navigating away", () => {
    const history = new MemoryHistory([
      "/today",
      "/documents?episode=ep-1&doc=doc-1",
    ]);
    history.replaceState({ __NA: true }, "", history.href);
    closeDocumentSelectionHistoryEntry(
      history,
      "/documents",
      "episode=ep-1&doc=doc-1",
      "doc-1",
    );

    expect(history.href).toBe("/documents?episode=ep-1");
  });
});
