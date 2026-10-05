/**
 * `GET /api/documents/inbound/usage` — the procedure choices of the vault's
 * filter bar.
 *
 * The reason and body site are ciphertext in the fixture as they are in the
 * database, so a route that published the stored bytes, or skipped the
 * decrypt, goes red. The fake honours nothing about the `where`, so the test
 * asserts the `where` it was handed: a read that forgot the kind, the owner,
 * or the live-document condition would otherwise pass against a fixture of
 * linked procedures only.
 *
 * Mutation checks (each run, each seen red):
 *   - drop `kind: "PROCEDURE"` from the read → "reads only the owner's live
 *     procedures with a live document" goes red;
 *   - read the procedures without the `visible("profile")` check → "a grant
 *     without the visits section gets no procedure" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  encounterFindMany: vi.fn(),
  requireRecordAuth: vi.fn(),
  visible: vi.fn((_domain: string) => true),
  actingDomainVisibility: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (handler: unknown) => handler,
  requireRecordAuth: mocks.requireRecordAuth,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => undefined,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    encounter: { findMany: mocks.encounterFindMany },
    $queryRaw: vi.fn(async () => [{ used: BigInt(0) }]),
    documentContentIndex: { count: vi.fn(async () => 0) },
    inboundDocument: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/documents/upload-policy", () => ({
  DOCUMENT_ACCEPTED_EXTENSIONS: [".pdf"],
  resolveDocumentLimits: vi.fn(async () => ({
    quotaBytes: 1000,
    maxFileBytes: 100,
  })),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentAiCapability: vi.fn(async () => ({ available: false })),
}));
vi.mock("@/lib/links", () => ({
  listDistinctTargets: vi.fn(async () => []),
  listTargetsBySource: vi.fn(async () => new Map()),
  replaceTargets: vi.fn(),
}));
vi.mock("@/lib/sharing/acting-domains", () => ({
  actingDomainVisibility: mocks.actingDomainVisibility,
}));

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { GET } from "../route";

const handler = GET as unknown as () => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRecordAuth.mockResolvedValue({
    user: { id: "owner-1" },
    grantId: null,
  });
  mocks.visible.mockImplementation(() => true);
  mocks.actingDomainVisibility.mockImplementation(async () => mocks.visible);
  mocks.encounterFindMany.mockResolvedValue([
    {
      id: "enc-knee",
      occurredAt: new Date("2025-10-02T08:00:00Z"),
      reasonEncrypted: encryptToBytes("Knee arthroscopy"),
      bodySiteEncrypted: encryptToBytes("Knee"),
      laterality: "LEFT",
      practitioner: null,
    },
    {
      id: "enc-unnamed",
      occurredAt: new Date("2024-05-10T08:00:00Z"),
      reasonEncrypted: null,
      bodySiteEncrypted: null,
      laterality: null,
      practitioner: { name: "Day clinic" },
    },
  ]);
});

async function read() {
  const res = await handler();
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

describe("GET /api/documents/inbound/usage — linked procedures", () => {
  it("publishes the linked procedures with the reason and site decrypted", async () => {
    const data = await read();
    expect(data.linkedProcedures).toEqual([
      {
        encounterId: "enc-knee",
        occurredAt: "2025-10-02T08:00:00.000Z",
        reason: "Knee arthroscopy",
        bodySite: "Knee",
        laterality: "LEFT",
        practitionerName: null,
      },
      {
        encounterId: "enc-unnamed",
        occurredAt: "2024-05-10T08:00:00.000Z",
        reason: null,
        bodySite: null,
        laterality: null,
        practitionerName: "Day clinic",
      },
    ]);
  });

  it("reads only the owner's live procedures with a live document, label columns only", async () => {
    await read();
    expect(mocks.encounterFindMany).toHaveBeenCalledTimes(1);
    const arg = mocks.encounterFindMany.mock.calls[0]![0];
    expect(arg.where).toEqual({
      userId: "owner-1",
      deletedAt: null,
      kind: "PROCEDURE",
      documentLinks: {
        some: { userId: "owner-1", document: { deletedAt: null } },
      },
    });
    // No outcome, no practitioner contact fields leave the database.
    expect(Object.keys(arg.select).sort()).toEqual([
      "bodySiteEncrypted",
      "id",
      "laterality",
      "occurredAt",
      "practitioner",
      "reasonEncrypted",
    ]);
    expect(arg.select.practitioner).toEqual({ select: { name: true } });
    expect(arg.take).toBeGreaterThan(0);
  });

  it("reads the record owner's procedures for a delegate whose grant covers visits", async () => {
    mocks.requireRecordAuth.mockResolvedValue({
      user: { id: "owner-1" },
      grantId: "grant-1",
    });
    const data = await read();
    expect(mocks.actingDomainVisibility).toHaveBeenCalledWith(
      expect.anything(),
      "grant-1",
    );
    expect(mocks.visible).toHaveBeenCalledWith("profile");
    expect(data.linkedProcedures).toHaveLength(2);
    expect(mocks.encounterFindMany.mock.calls[0]![0].where.userId).toBe(
      "owner-1",
    );
  });

  it("a grant without the visits section gets no procedure, and nothing is read", async () => {
    mocks.requireRecordAuth.mockResolvedValue({
      user: { id: "owner-1" },
      grantId: "grant-1",
    });
    mocks.visible.mockImplementation((domain) => domain !== "profile");
    const data = await read();
    expect(data.linkedProcedures).toEqual([]);
    expect(mocks.encounterFindMany).not.toHaveBeenCalled();
    // The positive control: the rest of the payload is still served.
    expect(data.quotaBytes).toBe(1000);
    expect(data.linkedEpisodes).toEqual([]);
  });

  it("reads one undecryptable reason as unnamed instead of failing the vault", async () => {
    mocks.encounterFindMany.mockResolvedValue([
      {
        id: "enc-broken",
        occurredAt: new Date("2025-01-01T00:00:00Z"),
        reasonEncrypted: new Uint8Array([1, 2, 3, 4]),
        bodySiteEncrypted: null,
        laterality: null,
        practitioner: null,
      },
    ]);
    const data = await read();
    expect(data.linkedProcedures).toEqual([
      expect.objectContaining({ encounterId: "enc-broken", reason: null }),
    ]);
  });
});
