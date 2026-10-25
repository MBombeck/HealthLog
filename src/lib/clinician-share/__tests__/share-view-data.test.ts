/**
 * v1.11.0 — clinician-view scoped data load guarantees.
 *
 * The public clinician view aggregates ONLY the data the owner froze into the
 * link, and it must NEVER surface the insurance number (KVNR). KVNR is
 * default-OFF by construction: `loadShareViewData` calls the doctor-report
 * aggregator with the frozen window + section toggles and nothing else — no
 * identifier opt-in, no decrypt path. This test pins that contract so a future
 * change can't silently widen the clinician view to leak the KVNR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The loader resolves the whole module MAP rather than the single
// `doctorReport` key. The per-leaf "shared, but switched off at the source"
// verdicts the clinician view renders come off that same read: derived from a
// second one, the notice on the page and the absence of the data behind it
// could disagree.
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(async () => allModulesOn()),
}));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
// The real selection resolver is used so the "empty scope ⇒ documents-only"
// signal is exercised end to end (a stubbed one would let the test lie about
// which sectionsJson resolves to an empty report scope).
vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLinkDocument: { findMany: vi.fn() },
  },
}));

import { loadShareViewData } from "../share-view-data";
import { resolveModuleMap } from "@/lib/modules/gate";
// From the registry, not the gate: the gate is mocked above, so its re-export
// of the key list would come back undefined.
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import {
  selectionToBlob,
  selectionFromLeaves,
} from "@/lib/report-selection/selection";
import { prisma } from "@/lib/db";
import type { ShareContext } from "../resolve-share-token";

/** Every module on — the shape `resolveModuleMap` returns for a fresh account. */
function allModulesOn(): Record<ModuleKey, boolean> {
  return Object.fromEntries(MODULE_KEYS.map((key) => [key, true])) as Record<
    ModuleKey,
    boolean
  >;
}

/** Every module on except the named ones. */
function modulesWithout(...off: ModuleKey[]): Record<ModuleKey, boolean> {
  const map = allModulesOn();
  for (const key of off) map[key] = false;
  return map;
}

const collect = collectDoctorReportData as ReturnType<typeof vi.fn>;
const moduleMap = resolveModuleMap as ReturnType<typeof vi.fn>;
const findDocs = prisma.clinicianShareLinkDocument.findMany as ReturnType<
  typeof vi.fn
>;

function ctx(overrides: Partial<ShareContext> = {}): ShareContext {
  return {
    shareLinkId: "link-1",
    ownerUserId: "owner-1",
    label: "Clinic",
    rangeStart: new Date("2026-01-01T00:00:00Z"),
    rangeEnd: new Date("2026-02-01T00:00:00Z"),
    sectionsJson: selectionToBlob(selectionFromLeaves(["WEIGHT", "PULSE"])),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  } as ShareContext;
}

describe("loadShareViewData — KVNR default OFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({
      patient: { displayName: "Shared record" },
    });
    findDocs.mockResolvedValue([]);
  });

  it("scopes the aggregator to the OWNER from the share context, never the wire", async () => {
    await loadShareViewData(ctx());
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]![0]).toBe("owner-1");
  });

  it("never requests an identifier / KVNR opt-in from the aggregator", async () => {
    await loadShareViewData(ctx());
    // The third argument is the link's frozen selection and nothing else — no
    // includeIdentifiers, no kvnr, no decrypt flag, and no fourth argument at
    // all. The insurance leaf is refused at create, so it cannot be in there.
    const selection = collect.mock.calls[0]![2] as {
      has: (leaf: string) => boolean;
      leaves: string[];
    };
    expect(selection.leaves).toEqual(["PULSE", "WEIGHT"]);
    expect(selection.has("INSURANCE")).toBe(false);
    expect(collect.mock.calls[0]![3]).toBeUndefined();
  });

  it("returns a report payload carrying no insurance number", async () => {
    const { report } = await loadShareViewData(ctx());
    const patient = (report as { patient?: Record<string, unknown> }).patient;
    expect(patient).not.toHaveProperty("insuranceNumber");
    expect(patient).not.toHaveProperty("kvnr");
  });

  it("lists no document once the owner switched the documents module off", async () => {
    moduleMap.mockResolvedValueOnce(modulesWithout("inboundDocuments"));
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: null,
          byteSize: 1,
          mimeType: "application/pdf",
        },
      },
    ]);
    const { documents } = await loadShareViewData(ctx());
    expect(documents).toEqual([]);
    expect(findDocs).not.toHaveBeenCalled();
  });

  it("lists the frozen document set as metadata only (never bytes)", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
      {
        document: {
          id: "doc-b",
          title: null,
          kind: "OTHER",
          documentDate: null,
          byteSize: 6789,
          mimeType: "application/msword",
        },
      },
    ]);

    const { documents } = await loadShareViewData(ctx());

    // Scoped to THIS link + owner + live rows; the blob column is never named.
    const arg = findDocs.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: { document: { select: Record<string, boolean> } };
    };
    expect(arg.where).toEqual({
      shareLinkId: "link-1",
      document: { userId: "owner-1", deletedAt: null },
    });
    expect(arg.select.document.select).not.toHaveProperty("contentEncrypted");

    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
      {
        id: "doc-b",
        title: null,
        kind: "OTHER",
        documentDate: null,
        byteSize: 6789,
        mimeType: "application/msword",
        servingClass: "attachment",
      },
    ]);
  });

  it("uses the frozen rangeStart and resolves a rolling rangeEnd to now", async () => {
    const now = Date.now();
    await loadShareViewData(ctx({ rangeEnd: null }));
    const range = collect.mock.calls[0]![1] as {
      start: Date;
      end: Date;
      days: number;
    };
    expect(range.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Rolling end materialises near "now", never before the frozen start.
    expect(range.end.getTime()).toBeGreaterThanOrEqual(now - 5_000);
    expect(range.days).toBeGreaterThan(0);
  });
});

/**
 * The load-bearing privacy guarantee: a documents-only share (every report
 * section OFF) serves ZERO health metrics. The doctor-report aggregator is
 * never called, so no vital / lab / medication / wellness figure ever leaves
 * the database — the recipient sees only the attached document(s). "Share this
 * document" means the document, not the whole record.
 */
describe("loadShareViewData — documents-only share exposes no health data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("never aggregates a report and returns report=null when no section is enabled", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
    ]);

    const { report, documentOnly, documents } = await loadShareViewData(
      ctx({ sectionsJson: selectionToBlob(selectionFromLeaves([])) }),
    );

    // The one guarantee: the aggregator is NEVER invoked — no health data is
    // read from the DB, let alone served.
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);

    // The attached document is still surfaced (metadata only, never bytes).
    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
    ]);
  });

  it("still aggregates for a record share that names leaves", async () => {
    // A link whose frozen scope names leaves DOES aggregate — the empty-scope
    // short-circuit must not swallow a normal record share.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ documentOnly: false }),
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(documentOnly).toBe(false);
    expect(report).not.toBeNull();
  });

  it("serves nothing for a legacy blob this build cannot read", async () => {
    // Every such link was revoked by migration 0273; this is the second lock
    // behind that. A shape the server cannot read is not consent to anything,
    // so it resolves to the empty selection rather than to a default scope.
    const { report, documentOnly } = await loadShareViewData(
      ctx({
        sectionsJson: { bp: true, weight: true, pulse: true },
        documentOnly: false,
      }),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);
  });
});

/**
 * v1.28.16 — the frozen `documentOnly` COLUMN is authoritative. Once a link is
 * created documents-only, it stays documents-only regardless of what the report
 * sections resolve to — so a report section added to the prefs shape LATER can
 * never re-open an existing documents-only link. The legacy fallback (derive
 * from "all sections off") still holds for pre-column links where the flag is
 * false.
 */
describe("loadShareViewData — documentOnly column is authoritative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("serves no report when the column is set, even if sections would aggregate", async () => {
    // Sections that resolve to an ENABLED scope (defaults) — the derived check
    // alone would run the aggregator. The frozen column must veto it. This is
    // the exact future-leak the column closes: a new section defaulting on can
    // no longer widen an old documents-only link.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ documentOnly: true }),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);
  });

  it("falls back to the derived all-off check for a legacy link (column false)", async () => {
    // A pre-column documents-only link reads `documentOnly:false` from the row
    // but still has every section off — the derived fallback keeps it closed.
    const { report, documentOnly } = await loadShareViewData(
      ctx({
        sectionsJson: selectionToBlob(selectionFromLeaves([])),
        documentOnly: false,
      }),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);
  });
});

/**
 * The frozen scope reaches the aggregator exactly as it was stored.
 *
 * The grouped/flat fold this block used to pin is gone with the shapes it
 * folded between: the link stores the leaf list the owner chose and the
 * aggregator reads that same list, so there is no second representation left
 * to disagree with the first.
 */
describe("loadShareViewData — the frozen scope reaches the aggregator intact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("passes exactly the leaves the link froze", async () => {
    await loadShareViewData(
      ctx({
        sectionsJson: selectionToBlob(
          selectionFromLeaves(["LAB_RESULTS", "BLOOD_PRESSURE_SYS"]),
        ),
        documentOnly: false,
      }),
    );
    const selection = collect.mock.calls[0]![2] as {
      has: (leaf: string) => boolean;
      leaves: string[];
    };
    expect(selection.leaves).toEqual(["BLOOD_PRESSURE_SYS", "LAB_RESULTS"]);
    expect(selection.has("WEIGHT")).toBe(false);
    expect(selection.has("MOOD")).toBe(false);
  });

  it("drops a leaf id this build no longer knows", async () => {
    await loadShareViewData(
      ctx({
        sectionsJson: { v: 2, leaves: ["WEIGHT", "SOMETHING_RETIRED"] },
        documentOnly: false,
      }),
    );
    const selection = collect.mock.calls[0]![2] as { leaves: string[] };
    expect(selection.leaves).toEqual(["WEIGHT"]);
  });
});

/**
 * v1.30.22 — the owner's `doctorReport` module gates this surface too.
 *
 * Found while tracing every caller of the whole-record aggregate for the MCP
 * fix: this link serves that same payload to an unauthenticated third party
 * and never consulted the module key, so an owner (or an operator, via the
 * availability switch ANDed above the user toggle) who turned the module off
 * still had the full record served.
 *
 * Degrades to the share's OWN documents-only state rather than throwing:
 * `documentOnly` is an existing, load-bearing privacy mode here (report
 * `null`, aggregator never called), so a disabled module collapses the link to
 * exactly the documents the owner attached — fail-closed for the health record
 * without 500-ing a public link.
 */
describe("clinician share — owner doctorReport module gate", () => {
  beforeEach(() => {
    // Sibling of the suite above, so the outer reset does not reach here.
    vi.clearAllMocks();
    moduleMap.mockResolvedValue(allModulesOn());
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
  });

  it("aggregates normally with the module on", async () => {
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(ctx({ documentOnly: false }));

    expect(res.documentOnly).toBe(false);
    expect(res.report).not.toBeNull();
    expect(collect).toHaveBeenCalled();
  });

  it("collapses to documents-only with the module off", async () => {
    moduleMap.mockResolvedValue(modulesWithout("doctorReport"));
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(ctx({ documentOnly: false }));

    expect(res.documentOnly).toBe(true);
    expect(res.report).toBeNull();
    // Load-bearing: the aggregator is never called, so no health data leaves
    // the DB at all — not built-then-withheld.
    expect(collect).not.toHaveBeenCalled();
  });

  it("gates on the OWNER's module state, not a viewer's", async () => {
    // The link is public; there is no viewer session. The owner id must come
    // from the frozen share context.
    findDocs.mockResolvedValue([]);
    await loadShareViewData(ctx({ documentOnly: false }));
    expect(moduleMap).toHaveBeenCalledWith("owner-1");
  });

  it("closes the operator kill-switch path too", async () => {
    // The operator layer and the per-user layer resolve into the same map, so
    // an operator-disabled `doctorReport` arrives here as the same `false`.
    moduleMap.mockResolvedValue(modulesWithout("doctorReport"));
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(ctx({ documentOnly: false }));

    expect(res.documentOnly).toBe(true);
    expect(collect).not.toHaveBeenCalled();
  });
});

/**
 * The third state a recipient has to be able to see.
 *
 * A leaf the owner DID share, in a domain their account has switched off,
 * produces exactly the same absence in the payload as a leaf they shared and
 * never recorded anything for. The loader carries the module verdict out
 * alongside the payload so the page can say which one it is, and it carries
 * ONLY leaves the selection admits — a withheld leaf's module state is not the
 * recipient's business in any direction.
 */
describe("loadShareViewData — leaves shared but switched off at the source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    moduleMap.mockResolvedValue(allModulesOn());
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("names a selected leaf whose owning module is off", async () => {
    moduleMap.mockResolvedValue(modulesWithout("labs"));
    const res = await loadShareViewData(
      ctx({
        sectionsJson: selectionToBlob(
          selectionFromLeaves(["LAB_RESULTS", "WEIGHT"]),
        ),
      }),
    );
    expect(res.unavailableLeaves).toEqual(["LAB_RESULTS"]);
  });

  it("stays empty when every selected leaf's module is on", async () => {
    const res = await loadShareViewData(
      ctx({
        sectionsJson: selectionToBlob(
          selectionFromLeaves(["LAB_RESULTS", "MOOD", "WEIGHT"]),
        ),
      }),
    );
    expect(res.unavailableLeaves).toEqual([]);
  });

  it("never names a leaf the link does not carry", async () => {
    // `mood` is off AND unshared. The recipient learns nothing about it,
    // because they were never told it existed.
    moduleMap.mockResolvedValue(modulesWithout("mood"));
    const res = await loadShareViewData(
      ctx({ sectionsJson: selectionToBlob(selectionFromLeaves(["WEIGHT"])) }),
    );
    expect(res.unavailableLeaves).toEqual([]);
  });
});
