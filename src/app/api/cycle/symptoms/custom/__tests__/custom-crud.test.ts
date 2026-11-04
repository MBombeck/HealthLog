/**
 * v1.15.1 — custom cycle-symptom CRUD route guards: create cap + encrypted
 * label, ownership 404 on edit/delete, non-custom-key rejection, soft-delete
 * vs purge, and the gate refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  cycleSymptom: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cycle/gate", () => ({
  requireCycleEnabled: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29 }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { PATCH, DELETE } from "../[key]/route";
import { getSession } from "@/lib/auth/session";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import { apiError } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "t",
    role: "USER" as const,
    gender: "FEMALE",
  },
};

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: {} as never,
  });
});

describe("GET /api/cycle/symptoms/custom", () => {
  it("returns the caller's active customs with decrypted labels", async () => {
    db.cycleSymptom.findMany.mockResolvedValue([
      { key: "custom:abc", icon: "Brain", labelEncrypted: "enc:Dizziness" },
    ]);
    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { symptoms: { key: string; label: string; custom: boolean }[] };
    };
    expect(body.data.symptoms).toEqual([
      { key: "custom:abc", label: "Dizziness", icon: "Brain", custom: true },
    ]);
  });
});

describe("POST /api/cycle/symptoms/custom", () => {
  it("creates a custom symptom, stores the label encrypted, returns it", async () => {
    db.cycleSymptom.count.mockResolvedValue(2);
    db.cycleSymptom.create.mockResolvedValue({
      key: "custom:abc",
      icon: "Brain",
    });
    const res = await POST(
      jsonReq("http://localhost/api/cycle/symptoms/custom", "POST", {
        label: "Dizziness",
        icon: "Brain",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { custom: boolean; label: string; key: string };
    };
    expect(body.data).toMatchObject({
      custom: true,
      label: "Dizziness",
      key: "custom:abc",
    });
    // Label is stored encrypted, never plaintext.
    expect(db.cycleSymptom.create.mock.calls[0][0].data.labelEncrypted).toBe(
      "enc:Dizziness",
    );
    // Owner-scoped + hung under the custom category.
    expect(db.cycleSymptom.create.mock.calls[0][0].data.userId).toBe("user-1");
    expect(db.cycleSymptom.create.mock.calls[0][0].data.categoryId).toBe(
      "csc_custom",
    );
  });

  it("rejects over the per-user cap with 422", async () => {
    db.cycleSymptom.count.mockResolvedValue(50);
    const res = await POST(
      jsonReq("http://localhost/api/cycle/symptoms/custom", "POST", {
        label: "X",
      }),
    );
    expect(res.status).toBe(422);
    expect(db.cycleSymptom.create).not.toHaveBeenCalled();
  });

  it("refuses when cycle tracking is disabled (403)", async () => {
    vi.mocked(requireCycleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError("Cycle tracking is not enabled", 403),
    });
    const res = await POST(
      jsonReq("http://localhost/api/cycle/symptoms/custom", "POST", {
        label: "X",
      }),
    );
    expect(res.status).toBe(403);
    expect(db.cycleSymptom.count).not.toHaveBeenCalled();
  });
});

describe("PATCH/DELETE /api/cycle/symptoms/custom/:key", () => {
  const params = (key: string) => ({ params: Promise.resolve({ key }) });

  it("404s when the key is not the caller's own custom symptom", async () => {
    db.cycleSymptom.findFirst.mockResolvedValue(null);
    const res = await PATCH(
      jsonReq("http://localhost/api/cycle/symptoms/custom/custom:x", "PATCH", {
        isActive: false,
      }),
      params("custom:x"),
    );
    expect(res.status).toBe(404);
  });

  it("404s a non-custom key without touching the DB", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/cycle/symptoms/custom/cramps"),
      params("cramps"),
    );
    expect(res.status).toBe(404);
    expect(db.cycleSymptom.findFirst).not.toHaveBeenCalled();
  });

  it("rechecks the cap on reactivation (hidden → active) and 422s when full", async () => {
    // A soft-hidden row doesn't count toward the active cap; flipping it back
    // to active must re-clear the limit so hide-then-reenable can't bypass it.
    db.cycleSymptom.findFirst.mockResolvedValue({ id: "id1", isActive: false });
    db.cycleSymptom.count.mockResolvedValue(50);
    const res = await PATCH(
      jsonReq(
        "http://localhost/api/cycle/symptoms/custom/custom:abc",
        "PATCH",
        {
          isActive: true,
        },
      ),
      params("custom:abc"),
    );
    expect(res.status).toBe(422);
    expect(db.cycleSymptom.update).not.toHaveBeenCalled();
  });

  it("does not recheck the cap when reactivation is not requested", async () => {
    db.cycleSymptom.findFirst.mockResolvedValue({ id: "id1", isActive: true });
    db.cycleSymptom.update.mockResolvedValue({
      key: "custom:abc",
      icon: "Tag",
      isActive: true,
      labelEncrypted: "enc:Renamed",
    });
    const res = await PATCH(
      jsonReq(
        "http://localhost/api/cycle/symptoms/custom/custom:abc",
        "PATCH",
        {
          label: "Renamed",
        },
      ),
      params("custom:abc"),
    );
    expect(res.status).toBe(200);
    expect(db.cycleSymptom.count).not.toHaveBeenCalled();
    // An edit leaves a ledger row too, symmetric with the DELETE sibling.
    // The decrypted label is never in the audit details, only the field names.
    expect(vi.mocked(auditLog)).toHaveBeenCalledWith(
      "cycle.symptom.custom.update",
      expect.objectContaining({
        details: expect.objectContaining({ fields: expect.any(Array) }),
      }),
    );
  });

  it("soft-deactivates by default and hard-deletes on ?purge=true", async () => {
    db.cycleSymptom.findFirst.mockResolvedValue({ id: "id1" });
    const soft = await DELETE(
      new NextRequest("http://localhost/api/cycle/symptoms/custom/custom:abc"),
      params("custom:abc"),
    );
    expect(soft.status).toBe(200);
    expect(db.cycleSymptom.update).toHaveBeenCalledWith({
      where: { id: "id1" },
      data: { isActive: false },
    });
    expect(db.cycleSymptom.delete).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireCycleEnabled).mockResolvedValue({
      enabled: true,
      profile: {} as never,
    });
    db.cycleSymptom.findFirst.mockResolvedValue({ id: "id1" });
    const purge = await DELETE(
      new NextRequest(
        "http://localhost/api/cycle/symptoms/custom/custom:abc?purge=true",
      ),
      params("custom:abc"),
    );
    expect(purge.status).toBe(200);
    expect(db.cycleSymptom.delete).toHaveBeenCalledWith({
      where: { id: "id1" },
    });
  });
});
