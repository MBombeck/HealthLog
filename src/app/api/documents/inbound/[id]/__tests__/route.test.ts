import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.25 — documents library: owner-scoped metadata edit.
 *
 * Pins that PATCH is owner-scoped (a caller cannot touch another user's
 * document — the `where` carries the session userId, so a foreign row resolves
 * to a 404) and that an own-row edit sets only the sent fields (no mass
 * assignment).
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    documentConditionLink: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    encounterDocumentLink: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    vaccinationDocumentLink: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    vaccinationRecord: {
      findMany: vi.fn(),
    },
    documentContentIndex: {
      findUnique: vi.fn(),
    },
    documentThumbnail: {
      findUnique: vi.fn(),
    },
    illnessEpisode: {
      findMany: vi.fn(),
    },
    encounter: {
      findMany: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// `related[]` has its own tests (`src/lib/links/__tests__`); here it is the
// empty list, so the detail assertions stay about the document.
vi.mock("@/lib/links/related", () => ({
  withRelated: async (_tx: unknown, detail: object) => ({
    ...detail,
    related: [],
  }),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `v1.${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^v1\./u, "")),
  encryptBytes: vi.fn((b: Buffer) => b),
  decryptBytes: vi.fn((b: Buffer) => b),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: vi.fn(() => new Uint8Array([1])),
  decryptFromBytes: vi.fn(() => "{}"),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 239, resetAt: Date.now() }),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
// Owner by default (every section open); the redaction case narrows it.
vi.mock("@/lib/sharing/acting-domains", () => ({
  actingDomainVisibility: vi.fn(async () => () => true),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function mkReq(id: string, body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function docRow(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "DOCTOR_REPORT",
    title: "Renamed",
    filename: "x.png",
    mimeType: "image/png",
    byteSize: 70,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: new Date("2026-05-01T00:00:00.000Z"),
    errorReason: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    facts: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.encounterDocumentLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.encounter.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.vaccinationDocumentLink.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.vaccinationDocumentLink.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.vaccinationDocumentLink.createMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.documentConditionLink.findMany).mockResolvedValue(
    [] as never,
  );
  // The link service re-narrows both ends before it writes: the document it is
  // filing, and the episodes it is filing against.
  vi.mocked(prisma.inboundDocument.findMany).mockResolvedValue([
    { id: "doc-1" },
  ] as never);
  vi.mocked(prisma.documentConditionLink.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.documentConditionLink.createMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.documentContentIndex.findUnique).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.documentThumbnail.findUnique).mockResolvedValue(
    null as never,
  );
});

describe("PATCH /api/documents/inbound/[id]", () => {
  it("cannot touch another user's document (404, no update)", async () => {
    // The foreign row does not satisfy `{ id, userId, deletedAt: null }`.
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );

    const res = await PATCH(
      mkReq("foreign-doc", { title: "hijack" }) as never,
      ctx("foreign-doc") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();

    const where = vi.mocked(prisma.inboundDocument.findFirst).mock.calls[0]![0]!
      .where!;
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
  });

  it("edits only the sent fields on an owned document", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.inboundDocument.update).mockResolvedValue(
      docRow() as never,
    );
    vi.mocked(prisma.inboundDocument.findFirstOrThrow).mockResolvedValue(
      docRow({ kind: "IMAGING", title: "Renamed" }) as never,
    );

    const res = await PATCH(
      mkReq("doc-1", { title: "Renamed", kind: "IMAGING" }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);

    const arg = vi.mocked(prisma.inboundDocument.update).mock.calls[0][0];
    expect(arg.where).toEqual({ id: "doc-1" });
    expect(arg.data.title).toBe("Renamed");
    expect(arg.data.kind).toBe("IMAGING");
    // documentDate was not sent → not present in the update payload.
    expect("documentDate" in arg.data).toBe(false);
  });

  it("stores an edited filing date at noon UTC so it reads back on that day everywhere", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.inboundDocument.update).mockResolvedValue(
      docRow() as never,
    );
    vi.mocked(prisma.inboundDocument.findFirstOrThrow).mockResolvedValue(
      docRow() as never,
    );

    const res = await PATCH(
      mkReq("doc-1", { documentDate: "2026-05-03" }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    const arg = vi.mocked(prisma.inboundDocument.update).mock.calls[0][0];
    // UTC midnight is the previous evening west of UTC.
    expect((arg.data.documentDate as Date).toISOString()).toBe(
      "2026-05-03T12:00:00.000Z",
    );
  });

  it("422s on an empty update", async () => {
    const res = await PATCH(mkReq("doc-1", {}) as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    expect(prisma.inboundDocument.findFirst).not.toHaveBeenCalled();
  });

  it("replace-sets condition links from episodeIds", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([
      { id: "ep-1" },
      { id: "ep-2" },
    ] as never);
    vi.mocked(prisma.inboundDocument.findFirstOrThrow).mockResolvedValue(
      docRow() as never,
    );

    const res = await PATCH(
      mkReq("doc-1", { episodeIds: ["ep-1", "ep-2"] }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);

    // Replace-set: everything outside the set is deleted, the set is upserted.
    expect(prisma.documentConditionLink.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        documentId: "doc-1",
        episodeId: { notIn: ["ep-1", "ep-2"] },
      },
    });
    expect(prisma.documentConditionLink.createMany).toHaveBeenCalledWith({
      data: [
        { documentId: "doc-1", episodeId: "ep-1", userId: "user-1" },
        { documentId: "doc-1", episodeId: "ep-2", userId: "user-1" },
      ],
      skipDuplicates: true,
    });
    // A links-only PATCH does not touch the metadata columns.
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  });

  it("refuses a foreign episodeId with a 404-shaped response", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    // The owner-narrowed lookup misses the foreign id.
    vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);

    const res = await PATCH(
      mkReq("doc-1", { episodeIds: ["ep-foreign"] }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.documentConditionLink.deleteMany).not.toHaveBeenCalled();
    expect(prisma.documentConditionLink.createMany).not.toHaveBeenCalled();
  });

  it("replace-sets vaccination links from vaccinationIds and audits the change", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([
      { id: "dose-1" },
      { id: "dose-2" },
    ] as never);
    vi.mocked(prisma.inboundDocument.findFirstOrThrow).mockResolvedValue(
      docRow() as never,
    );

    const res = await PATCH(
      mkReq("doc-1", { vaccinationIds: ["dose-1", "dose-2"] }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    // The owner-narrowing read is scoped by the session user and the
    // tombstone, never by anything the body carried.
    const narrowWhere = vi.mocked(prisma.vaccinationRecord.findMany).mock
      .calls[0]![0]!.where!;
    expect(narrowWhere).toMatchObject({ userId: "user-1", deletedAt: null });
    expect(prisma.vaccinationDocumentLink.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        documentId: "doc-1",
        vaccinationId: { notIn: ["dose-1", "dose-2"] },
      },
    });
    expect(prisma.vaccinationDocumentLink.createMany).toHaveBeenCalledWith({
      data: [
        { documentId: "doc-1", vaccinationId: "dose-1", userId: "user-1" },
        { documentId: "doc-1", vaccinationId: "dose-2", userId: "user-1" },
      ],
      skipDuplicates: true,
    });
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      "documents.inbound.update",
      expect.objectContaining({
        details: expect.objectContaining({ fields: ["vaccinationIds"] }),
      }),
    );
    const body = await res.json();
    expect(body.data.vaccinationLinks).toEqual([]);
  });

  it("refuses a foreign dose with a 404-shaped response and writes nothing", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
    } as never);
    vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([] as never);

    const res = await PATCH(
      mkReq("doc-1", { vaccinationIds: ["dose-foreign"] }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.vaccinationDocumentLink.deleteMany).not.toHaveBeenCalled();
    expect(prisma.vaccinationDocumentLink.createMany).not.toHaveBeenCalled();
  });

  it("refuses more dose links than one request may carry", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `dose-${i}`);
    const res = await PATCH(
      mkReq("doc-1", { vaccinationIds: ids }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(422);
    expect(prisma.inboundDocument.findFirst).not.toHaveBeenCalled();
  });
});

describe("GET /api/documents/inbound/[id] — vaccination links", () => {
  function getReq(id: string): NextRequest {
    return new NextRequest(
      new URL(`http://localhost/api/documents/inbound/${id}`),
    );
  }

  beforeEach(() => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      docRow() as never,
    );
    vi.mocked(prisma.vaccinationDocumentLink.findMany).mockResolvedValue([
      { documentId: "doc-1", vaccinationId: "dose-1" },
      { documentId: "doc-1", vaccinationId: "dose-2" },
    ] as never);
    // First read: the link service's target re-read; second: the identity
    // read that lets the client name each dose.
    vi.mocked(prisma.vaccinationRecord.findMany).mockResolvedValue([
      {
        id: "dose-1",
        antigenSlug: "tetanus",
        vaccineName: null,
        occurredAt: new Date("1991-04-02T00:00:00.000Z"),
      },
      {
        id: "dose-2",
        antigenSlug: "no-longer-in-catalogue",
        vaccineName: "DTP",
        occurredAt: new Date("1991-06-02T00:00:00.000Z"),
      },
    ] as never);
  });

  it("lists every dose the page is filed against, named for the reader's bundle", async () => {
    const res = await GET(getReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.vaccinationLinks).toEqual([
      {
        vaccinationId: "dose-1",
        occurredAt: "1991-04-02T00:00:00.000Z",
        catalogSlug: "tetanus",
        vaccineName: null,
      },
      {
        vaccinationId: "dose-2",
        occurredAt: "1991-06-02T00:00:00.000Z",
        catalogSlug: null,
        vaccineName: "DTP",
      },
    ]);
  });

  it("withholds the doses from a grant that does not cover the health background", async () => {
    vi.mocked(actingDomainVisibility).mockResolvedValueOnce(
      (domain) => domain !== "profile",
    );
    const res = await GET(getReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.vaccinationLinks).toBeNull();
    expect(prisma.vaccinationDocumentLink.findMany).not.toHaveBeenCalled();
  });
});
