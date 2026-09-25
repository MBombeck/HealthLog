/**
 * `GET /api/encounters/procedures` — the procedure history, searched after the
 * decrypt.
 *
 * The body site is ciphertext in the fixture as it is in the database, so a
 * route that searched the stored bytes instead of the decrypted text would
 * find nothing and go red here. The fake honours nothing about the `where`, so
 * the test asserts the `where` it was handed directly: a procedure history
 * that forgot the kind or the status filter would otherwise pass against a
 * fixture of procedures only.
 *
 * Mutation checks (each run, each seen red):
 *   - drop `kind: "PROCEDURE"` from the read → "reads only procedures that
 *     happened" goes red;
 *   - compute the facets over the filtered list → "offers every body site
 *     whatever the filter" goes red with one facet;
 *   - search `reasonEncrypted` bytes instead of the DTO → the knee search
 *     returns nothing and goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  encounterFindMany: vi.fn(),
  userFindUnique: vi.fn(),
  requireRecordAuth: vi.fn(),
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
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock("@/lib/sharing/acting-domains", () => ({
  actingDomainVisibility: vi.fn(async () => () => true),
}));
vi.mock("@/lib/links", () => ({
  listTargets: vi.fn(async () => []),
  listTargetsBySource: vi.fn(async () => new Map()),
  replaceTargets: vi.fn(),
}));

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { GET } from "../route";

const handler = GET as unknown as (req: NextRequest) => Promise<Response>;

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/encounters/procedures${query ? `?${query}` : ""}`,
  );
}

function row(
  id: string,
  day: number,
  bodySite: string | null,
  laterality: "LEFT" | "RIGHT" | "BOTH" | null,
  reason: string | null,
) {
  const at = new Date(Date.UTC(2020, 0, day));
  return {
    id,
    userId: "user-1",
    occurredAt: at,
    status: "DONE",
    kind: "PROCEDURE",
    practitionerId: null,
    practitioner: null,
    reminder: null,
    reminderId: null,
    reasonEncrypted: reason ? encryptToBytes(reason) : null,
    outcomeEncrypted: null,
    bodySiteEncrypted: bodySite ? encryptToBytes(bodySite) : null,
    laterality,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  };
}

interface Body {
  data: {
    procedures: Array<{ id: string; bodySite: string | null }>;
    bodySites: Array<{ bodySite: string; laterality: string | null }>;
    total: number;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRecordAuth.mockResolvedValue({
    user: { id: "user-1" },
    actor: { id: "user-1" },
    grantId: null,
  });
  mocks.userFindUnique.mockResolvedValue({
    timezone: "Europe/Berlin",
    locale: "de",
  });
  mocks.encounterFindMany.mockResolvedValue([
    row("p3", 30, "Knie", "RIGHT", "Arthroskopie"),
    row("p2", 20, "Gallenblase", null, "Cholezystektomie"),
    row("p1", 10, "Knie", "LEFT", "Meniskus"),
  ]);
});

describe("GET /api/encounters/procedures", () => {
  it("reads the health background at READ", async () => {
    await handler(request());
    expect(mocks.requireRecordAuth).toHaveBeenCalledWith("read", "profile");
  });

  it("reads only procedures that happened, for the caller", async () => {
    await handler(request());
    const args = mocks.encounterFindMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      userId: "user-1",
      deletedAt: null,
      kind: "PROCEDURE",
      status: "DONE",
    });
    expect(args.orderBy).toEqual({ occurredAt: "desc" });
    expect(args.take).toBeGreaterThan(0);
  });

  it("returns the whole history, newest first, with the decrypted site", async () => {
    const res = await handler(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.data.procedures.map((p) => p.id)).toEqual(["p3", "p2", "p1"]);
    expect(body.data.procedures[0].bodySite).toBe("Knie");
    expect(body.data.total).toBe(3);
  });

  it("searches the decrypted site together with the side, in the owner's language", async () => {
    const res = await handler(request("q=knie%20links"));
    const body = (await res.json()) as Body;
    expect(body.data.procedures.map((p) => p.id)).toEqual(["p1"]);
  });

  it("finds the English side word as well", async () => {
    const res = await handler(request("q=left"));
    const body = (await res.json()) as Body;
    expect(body.data.procedures.map((p) => p.id)).toEqual(["p1"]);
  });

  it("filters the side exactly", async () => {
    const res = await handler(request("laterality=RIGHT"));
    const body = (await res.json()) as Body;
    expect(body.data.procedures.map((p) => p.id)).toEqual(["p3"]);
  });

  it("offers every body site whatever the filter", async () => {
    const res = await handler(request("q=galle"));
    const body = (await res.json()) as Body;
    expect(body.data.procedures.map((p) => p.id)).toEqual(["p2"]);
    expect(body.data.bodySites).toHaveLength(3);
    expect(body.data.total).toBe(3);
  });

  it("refuses an unknown side with 422", async () => {
    const res = await handler(request("laterality=UP"));
    expect(res.status).toBe(422);
    expect(mocks.encounterFindMany).not.toHaveBeenCalled();
  });
});
