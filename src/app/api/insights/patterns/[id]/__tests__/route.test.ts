import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ModuleGateModule from "@/lib/modules/gate";

vi.mock("@/lib/db", () => ({
  prisma: {
    correlationPattern: { findFirst: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleGateModule>()),
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

import { PATCH } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { apiError } from "@/lib/api-response";

const SESSION = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "owner-1", username: "owner", role: "USER", locale: "en" },
};
const PATTERN = {
  id: "pattern-1",
  userId: "owner-1",
  canonicalKey: `p1:${"a".repeat(64)}`,
  evidenceHash: "b".repeat(64),
  effectSize: 0.34,
  sampleSize: 42,
  dismissedAt: null,
};
const params = { params: Promise.resolve({ id: PATTERN.id }) };

function request(body: unknown) {
  return new NextRequest(
    `http://localhost/api/insights/patterns/${PATTERN.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("PATCH /api/insights/patterns/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION as never);
    vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  });

  it("accepts a dismissal whatever the AI analysis opt-out says (statistics are data)", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403),
    });

    const response = await PATCH(request({ dismissed: true }), params);

    // No such pattern in this fixture: reaching the lookup proves no module
    // gate stood in front of it.
    expect(response.status).toBe(404);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
    expect(prisma.correlationPattern.findFirst).toHaveBeenCalled();
  });

  it("stores the current evidence as the account-scoped dismissal baseline", async () => {
    vi.mocked(prisma.correlationPattern.findFirst).mockResolvedValue(
      PATTERN as never,
    );
    vi.mocked(prisma.correlationPattern.update).mockResolvedValue({
      ...PATTERN,
      dismissedAt: new Date("2026-07-28T10:00:00.000Z"),
    } as never);

    const response = await PATCH(request({ dismissed: true }), params);
    expect(response.status).toBe(200);
    expect(prisma.correlationPattern.findFirst).toHaveBeenCalledWith({
      where: { id: PATTERN.id, userId: "owner-1", isCurrent: true },
    });
    expect(prisma.correlationPattern.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PATTERN.id },
        data: expect.objectContaining({
          dismissedEvidenceHash: PATTERN.evidenceHash,
          dismissedEffectSize: PATTERN.effectSize,
          dismissedSampleSize: PATTERN.sampleSize,
        }),
      }),
    );
  });

  it("does not reveal a pattern outside the authenticated account", async () => {
    vi.mocked(prisma.correlationPattern.findFirst).mockResolvedValue(null);
    const response = await PATCH(request({ dismissed: true }), params);
    expect(response.status).toBe(404);
    expect(prisma.correlationPattern.update).not.toHaveBeenCalled();
  });

  it("rejects fields other than the dismissal decision", async () => {
    const response = await PATCH(
      request({ dismissed: true, factorKey: "OTHER" }),
      params,
    );
    expect(response.status).toBe(422);
    expect(prisma.correlationPattern.findFirst).not.toHaveBeenCalled();
  });
});
