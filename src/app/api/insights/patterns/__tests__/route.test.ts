import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModuleGateModule from "@/lib/modules/gate";

vi.mock("@/lib/db", () => ({
  prisma: {
    correlationPattern: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { apiError } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "owner-1", username: "owner", role: "USER", locale: "en" },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(prisma.correlationPattern.findMany).mockResolvedValue([]);
});

describe("GET /api/insights/patterns", () => {
  it("lists only the authenticated account's current patterns", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(prisma.correlationPattern.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "owner-1", isCurrent: true },
      }),
    );
  });

  it("serves the list whatever the AI analysis opt-out says (statistics are data)", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(requireModuleEnabled).not.toHaveBeenCalled();
    expect(prisma.correlationPattern.findMany).toHaveBeenCalled();
  });
});
