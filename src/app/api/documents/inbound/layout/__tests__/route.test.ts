/**
 * `/api/documents/inbound/layout` — the vault presentation.
 *
 * GET answers the defaults for an account that never chose, without writing
 * a row; PUT is preserve-when-absent per field, refuses unknown values and
 * unknown keys with the multi-issue 422, and both halves stop at the
 * documents module gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { DEFAULT_DOCUMENTS_LAYOUT } from "@/lib/documents/documents-layout";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

const callGet = GET as unknown as () => Promise<Response>;
const callPut = PUT as unknown as (req: NextRequest) => Promise<Response>;

function put(body: unknown): Promise<Response> {
  return callPut(
    new NextRequest("http://localhost/api/documents/inbound/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

describe("GET /api/documents/inbound/layout", () => {
  it("answers the defaults and writes nothing for an account that never chose", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentsLayoutJson: null,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(DEFAULT_DOCUMENTS_LAYOUT);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("serves the stored choice, repairing an unknown value field by field", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentsLayoutJson: { version: 1, view: "list", arrangement: "spiral" },
    } as never);

    const res = await callGet();
    expect((await res.json()).data).toEqual({
      version: 1,
      view: "list",
      arrangement: "stacked",
    });
  });

  it("stops at the module gate", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);

    const res = await callGet();
    expect(res.status).toBe(403);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("PUT /api/documents/inbound/layout", () => {
  it("keeps the stored arrangement when only the view changes", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentsLayoutJson: { version: 1, view: "cards", arrangement: "flow" },
    } as never);

    const res = await put({ version: 1, view: "list" });
    expect(res.status).toBe(200);
    const expected = { version: 1, view: "list", arrangement: "flow" };
    expect((await res.json()).data).toEqual(expected);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { documentsLayoutJson: expected },
    });
  });

  it("keeps the stored view when only the arrangement changes", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      documentsLayoutJson: { version: 1, view: "list", arrangement: "stacked" },
    } as never);

    const res = await put({ version: 1, arrangement: "flow" });
    expect((await res.json()).data).toEqual({
      version: 1,
      view: "list",
      arrangement: "flow",
    });
  });

  it("refuses an unknown value and an unknown key with 422 and writes nothing", async () => {
    const bad = await put({ version: 1, view: "carousel" });
    expect(bad.status).toBe(422);
    const extra = await put({ version: 1, view: "list", userId: "user-2" });
    expect(extra.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("stops at the module gate before reading the body", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    } as never);

    const res = await put({ version: 1, view: "list" });
    expect(res.status).toBe(403);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
