import { describe, expect, it } from "vitest";

import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  buildTimelineItems,
  buildVaultListApiSearch,
  classifyUploadFailure,
  countActiveFilters,
  documentCardKeyAction,
  documentDateKey,
  expandRangeSelection,
  formatBytes,
  formatMonthLabel,
  hasProcessingDocument,
  isDocumentProcessing,
  isRecentlyUploaded,
  parseUploadResponse,
  parseVaultSearchParams,
  RECENT_UPLOAD_WINDOW_MS,
  resolveBulkShareDocuments,
  SHARE_LINK_MAX_DOCUMENTS,
  vaultFiltersToSearch,
} from "../vault-utils";

function doc(overrides: Partial<InboundDocumentDto> = {}): InboundDocumentDto {
  return {
    id: "doc-1",
    kind: "DOCTOR_REPORT",
    title: null,
    filename: "letter.pdf",
    mimeType: "application/pdf",
    byteSize: 1024,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2026-03-10",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [],
    encounterLinks: [],
    servingClass: "inline",
    hasContentIndex: false,
    contentIndexSource: null,
    lastIndexAttemptAt: null,
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    createdAt: "2026-03-11T08:00:00.000Z",
    updatedAt: "2026-03-11T08:00:00.000Z",
    ...overrides,
  };
}

describe("URL facet round-trip", () => {
  it("parses q / kind / episode / year and serialises back identically", () => {
    const search = "q=MRT&kind=IMAGING%2CLAB_RESULT&episode=ep1&year=2025";
    const filters = parseVaultSearchParams(new URLSearchParams(search));
    expect(filters).toEqual({
      q: "MRT",
      kinds: ["IMAGING", "LAB_RESULT"],
      episodeId: "ep1",
      year: 2025,
    });
    expect(vaultFiltersToSearch(filters)).toBe(
      "q=MRT&kind=IMAGING%2CLAB_RESULT&episode=ep1&year=2025",
    );
  });

  it("accepts repeated kind params and drops unknown kinds", () => {
    const sp = new URLSearchParams();
    sp.append("kind", "IMAGING");
    sp.append("kind", "NOT_A_KIND");
    sp.append("kind", "IMAGING"); // duplicate collapses
    const filters = parseVaultSearchParams(sp);
    expect(filters.kinds).toEqual(["IMAGING"]);
  });

  it("normalises kind order so the cache key is stable", () => {
    const a = parseVaultSearchParams(
      new URLSearchParams("kind=LAB_RESULT,IMAGING"),
    );
    const b = parseVaultSearchParams(
      new URLSearchParams("kind=IMAGING,LAB_RESULT"),
    );
    expect(a).toEqual(b);
  });

  it("ignores a malformed year and returns the empty default view", () => {
    expect(parseVaultSearchParams(new URLSearchParams("year=20x5"))).toEqual(
      {},
    );
    expect(vaultFiltersToSearch({})).toBe("");
  });

  it("counts active facets per chip (search counts once)", () => {
    expect(countActiveFilters({})).toBe(0);
    expect(
      countActiveFilters({
        q: "a",
        kinds: ["IMAGING", "LAB_RESULT"],
        episodeId: "e",
        year: 2026,
      }),
    ).toBe(5);
  });
});

describe("API list search", () => {
  it("pins timeline sort, maps episode → episodeId, threads the cursor", () => {
    const search = buildVaultListApiSearch(
      { kinds: ["IMAGING"], episodeId: "ep1", year: 2025 },
      "cursor-9",
      50,
    );
    const sp = new URLSearchParams(search);
    expect(sp.get("kind")).toBe("IMAGING");
    expect(sp.get("episodeId")).toBe("ep1");
    expect(sp.get("year")).toBe("2025");
    expect(sp.get("sort")).toBe("documentDate");
    expect(sp.get("order")).toBe("desc");
    expect(sp.get("cursor")).toBe("cursor-9");
    expect(sp.get("limit")).toBe("50");
  });
});

describe("timeline items", () => {
  it("buckets by month and chunks rows to the column count", () => {
    const docs = [
      doc({ id: "a", documentDate: "2026-03-20" }),
      doc({ id: "b", documentDate: "2026-03-15" }),
      doc({ id: "c", documentDate: "2026-03-10" }),
      doc({ id: "d", documentDate: "2026-02-28" }),
    ];
    const items = buildTimelineItems(docs, 2);
    expect(items.map((i) => i.type)).toEqual([
      "month",
      "row",
      "row",
      "month",
      "row",
    ]);
    expect(items[0]).toEqual({ type: "month", key: "2026-03" });
    expect(items[1]).toMatchObject({ documents: [docs[0], docs[1]] });
    expect(items[2]).toMatchObject({ documents: [docs[2]] });
    expect(items[4]).toMatchObject({ documents: [docs[3]] });
  });

  it("files an undated document under its upload day", () => {
    const d = doc({ documentDate: null, createdAt: "2026-01-05T10:00:00Z" });
    expect(documentDateKey(d)).toBe("2026-01-05");
    const items = buildTimelineItems([d], 3);
    expect(items[0]).toEqual({ type: "month", key: "2026-01" });
  });

  it("keeps the DOM bounded: item count scales with rows, not documents", () => {
    const docs = Array.from({ length: 1000 }, (_, i) =>
      doc({ id: `d${i}`, documentDate: "2026-03-01" }),
    );
    const items = buildTimelineItems(docs, 4);
    // 1 month header + 250 rows — the virtualizer then windows over these.
    expect(items).toHaveLength(251);
  });

  it("formats a month key in the viewer's locale", () => {
    expect(formatMonthLabel("2026-03", "de")).toBe("März 2026");
    expect(formatMonthLabel("not-a-month", "de")).toBe("not-a-month");
  });
});

describe("byte formatting", () => {
  it("scales units and keeps one decimal below 10", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512 B");
    expect(formatBytes(26_214_400, "en")).toBe("25 MB");
    expect(formatBytes(1_288_490_189, "en")).toBe("1.2 GB");
  });
});

describe("upload response contract (§3.2)", () => {
  it("HTTP 200 + meta.duplicate returns the EXISTING row as a duplicate", () => {
    const body = JSON.stringify({
      data: doc({ id: "existing-row" }),
      error: null,
      meta: { duplicate: true },
    });
    const result = parseUploadResponse(200, body);
    expect(result).toMatchObject({
      ok: true,
      duplicate: true,
      document: { id: "existing-row" },
    });
  });

  it("a plain 201 success is not a duplicate", () => {
    const body = JSON.stringify({ data: doc({ id: "fresh" }), error: null });
    expect(parseUploadResponse(201, body)).toMatchObject({
      ok: true,
      duplicate: false,
      document: { id: "fresh" },
    });
  });

  it("maps every meta.reason to its translated-copy class", () => {
    expect(
      parseUploadResponse(
        413,
        JSON.stringify({
          data: null,
          error: "too large",
          meta: { reason: "fileTooLarge", maxFileBytes: 26_214_400 },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "fileTooLarge",
      maxFileBytes: 26_214_400,
      quotaBytes: undefined,
      usedBytes: undefined,
      existingId: undefined,
    });

    expect(
      parseUploadResponse(
        413,
        JSON.stringify({
          data: null,
          error: "quota",
          meta: {
            reason: "quotaExceeded",
            quotaBytes: 1_073_741_824,
            usedBytes: 1_000_000_000,
          },
        }),
      ),
    ).toMatchObject({
      ok: false,
      reason: "quotaExceeded",
      quotaBytes: 1_073_741_824,
      usedBytes: 1_000_000_000,
    });

    expect(
      classifyUploadFailure(415, { reason: "unsupportedType" }),
    ).toMatchObject({ reason: "unsupportedType" });
    expect(classifyUploadFailure(409, { reason: "purged" })).toMatchObject({
      reason: "purged",
    });
    expect(
      classifyUploadFailure(409, {
        reason: "duplicateExists",
        existingId: "row-1",
      }),
    ).toMatchObject({ reason: "duplicateExists", existingId: "row-1" });
  });

  it("falls back to the HTTP status when a proxy strips the body", () => {
    expect(parseUploadResponse(413, "")).toMatchObject({
      reason: "fileTooLarge",
    });
    expect(parseUploadResponse(415, "<html>")).toMatchObject({
      reason: "unsupportedType",
    });
    expect(parseUploadResponse(429, "")).toMatchObject({
      reason: "rateLimited",
    });
    expect(parseUploadResponse(500, "")).toMatchObject({ reason: "generic" });
  });
});

describe("shift-click range selection", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("selects the inclusive range between anchor and target, both ways", () => {
    expect(
      [...expandRangeSelection(order, new Set(["b"]), "b", "d")].sort(),
    ).toEqual(["b", "c", "d"]);
    expect(
      [...expandRangeSelection(order, new Set(["d"]), "d", "b")].sort(),
    ).toEqual(["b", "c", "d"]);
  });

  it("is additive — a range gesture never deselects", () => {
    const next = expandRangeSelection(order, new Set(["a", "c"]), "c", "e");
    expect([...next].sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("falls back to a plain toggle without a live anchor", () => {
    expect([...expandRangeSelection(order, new Set(), null, "c")]).toEqual([
      "c",
    ]);
    // Anchor filtered out of the current order → plain toggle (deselect).
    expect([
      ...expandRangeSelection(order, new Set(["c"]), "gone", "c"),
    ]).toEqual([]);
  });
});

describe("resolveBulkShareDocuments", () => {
  const corpus = [
    doc({ id: "d1", title: "Blood panel", filename: "bp.pdf" }),
    doc({ id: "d2", title: null, filename: "scan.jpg" }),
    doc({ id: "d3", title: null, filename: null }),
    doc({ id: "d4", title: "Referral" }),
  ];

  it("maps the selection to {id,title}, falling back title → filename → untitled", () => {
    const result = resolveBulkShareDocuments(
      corpus,
      new Set(["d1", "d2", "d3"]),
      "Untitled",
    );
    expect(result.overCap).toBe(false);
    if (result.overCap) throw new Error("unexpected over-cap");
    expect(result.documents).toEqual([
      { id: "d1", title: "Blood panel" },
      { id: "d2", title: "scan.jpg" },
      { id: "d3", title: "Untitled" },
    ]);
  });

  it("preserves corpus order and ignores ids not in the corpus", () => {
    const result = resolveBulkShareDocuments(
      corpus,
      new Set(["d4", "d1", "ghost"]),
      "Untitled",
    );
    if (result.overCap) throw new Error("unexpected over-cap");
    expect(result.documents.map((d) => d.id)).toEqual(["d1", "d4"]);
  });

  it("caps at SHARE_LINK_MAX_DOCUMENTS (50) — over the cap refuses rather than truncates", () => {
    const many = Array.from({ length: 60 }, (_, i) => doc({ id: `x${i}` }));
    const selected = new Set(many.map((d) => d.id));
    expect(selected.size).toBeGreaterThan(SHARE_LINK_MAX_DOCUMENTS);
    expect(resolveBulkShareDocuments(many, selected, "Untitled")).toEqual({
      overCap: true,
    });
  });

  it("allows exactly 50 selected documents", () => {
    const fifty = Array.from({ length: SHARE_LINK_MAX_DOCUMENTS }, (_, i) =>
      doc({ id: `y${i}` }),
    );
    const result = resolveBulkShareDocuments(
      fifty,
      new Set(fifty.map((d) => d.id)),
      "Untitled",
    );
    expect(result.overCap).toBe(false);
    if (result.overCap) throw new Error("unexpected over-cap");
    expect(result.documents).toHaveLength(SHARE_LINK_MAX_DOCUMENTS);
  });
});

// v1.29.x — the vault's "Processing…" / "Ready" chip + the poll-while-
// indexing refetch both key off the bounded recent-upload window rather than
// a bare `!hasContentIndex`, so an old / permanently-unindexed document never
// shows a stuck spinner and the list query never polls forever.
describe("isRecentlyUploaded / isDocumentProcessing / hasProcessingDocument", () => {
  const NOW = new Date("2026-03-11T08:10:00.000Z").getTime();

  it("is recently-uploaded just inside the window, not right at/after it", () => {
    const justInside = new Date(
      NOW - RECENT_UPLOAD_WINDOW_MS + 1000,
    ).toISOString();
    expect(isRecentlyUploaded(justInside, NOW)).toBe(true);

    const atTheEdge = new Date(NOW - RECENT_UPLOAD_WINDOW_MS).toISOString();
    expect(isRecentlyUploaded(atTheEdge, NOW)).toBe(false);
  });

  it("is never recently-uploaded for a future createdAt (clock skew defensiveness)", () => {
    const future = new Date(NOW + 1000).toISOString();
    expect(isRecentlyUploaded(future, NOW)).toBe(false);
  });

  it("is processing only while unindexed AND inside the recent-upload window", () => {
    const fresh = new Date(NOW - 1000).toISOString();
    expect(
      isDocumentProcessing({ createdAt: fresh, hasContentIndex: false }, NOW),
    ).toBe(true);
    // Indexed already — done, not processing, regardless of age.
    expect(
      isDocumentProcessing({ createdAt: fresh, hasContentIndex: true }, NOW),
    ).toBe(false);
    // Old and never indexed (unsupported format, content index disabled,
    // …) — outside the window, so it does NOT read as "still processing".
    const old = new Date(NOW - RECENT_UPLOAD_WINDOW_MS - 1000).toISOString();
    expect(
      isDocumentProcessing({ createdAt: old, hasContentIndex: false }, NOW),
    ).toBe(false);
  });

  it("hasProcessingDocument is true when ANY loaded document is still processing", () => {
    const fresh = new Date(NOW - 1000).toISOString();
    const old = new Date(NOW - RECENT_UPLOAD_WINDOW_MS - 1000).toISOString();
    const docs = [
      doc({ id: "d1", createdAt: old, hasContentIndex: false }),
      doc({ id: "d2", createdAt: fresh, hasContentIndex: false }),
    ];
    expect(hasProcessingDocument(docs, NOW)).toBe(true);
  });

  it("hasProcessingDocument is false when every document is indexed or outside the window", () => {
    const fresh = new Date(NOW - 1000).toISOString();
    const old = new Date(NOW - RECENT_UPLOAD_WINDOW_MS - 1000).toISOString();
    const docs = [
      doc({ id: "d1", createdAt: old, hasContentIndex: false }),
      doc({ id: "d2", createdAt: fresh, hasContentIndex: true }),
    ];
    expect(hasProcessingDocument(docs, NOW)).toBe(false);
  });

  it("hasProcessingDocument is false for an empty list", () => {
    expect(hasProcessingDocument([], NOW)).toBe(false);
  });
});

describe("documentCardKeyAction", () => {
  it("deletes on Delete and selects on Space", () => {
    expect(documentCardKeyAction("Delete")).toBe("delete");
    expect(documentCardKeyAction(" ")).toBe("select");
  });

  it("does NOT delete on Backspace", () => {
    // The reflex "go back" key on a card that takes focus by default, with
    // no other delete control and only a transient undo toast behind it.
    expect(documentCardKeyAction("Backspace")).toBeNull();
  });

  it("ignores every other key", () => {
    for (const key of ["Enter", "Escape", "a", "ArrowDown", "Del"]) {
      expect(documentCardKeyAction(key)).toBeNull();
    }
  });
});
