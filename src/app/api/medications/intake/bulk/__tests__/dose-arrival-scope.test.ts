/**
 * The Apple Health dose arrival record (`MEDICATION_DOSE` in the per-type
 * arrival table) describes the phone's Apple Health sync. A narrow,
 * single-purpose credential is not that sync, so a batch it sends never
 * writes the record, the same rule the measurement batch keeps.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    medicationIntakeEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    user: { update: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-handler")>();
  return { ...actual, requireAuth: vi.fn() };
});
vi.mock("@/lib/integrations/healthkit-type-sync", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/integrations/healthkit-type-sync")
    >();
  return { ...actual, recordHealthKitTypeArrivals: vi.fn() };
});
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import { recordHealthKitTypeArrivals } from "@/lib/integrations/healthkit-type-sync";
import { checkRateLimit } from "@/lib/rate-limit";

const USER = {
  id: "user-1",
  username: "tester",
  role: "USER" as const,
  timezone: "Europe/Berlin",
};

/** A replayed Apple dose: the cheapest batch that still counts as an arrival. */
async function postReplayedDose(
  syncTrigger: string = "background",
): Promise<Response> {
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
    { id: "row-existing", externalId: "hk-dose-1" },
  ] as never);
  return POST(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        syncTrigger,
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-1",
          },
        ],
      }),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([
    { id: "med-apple", externalSource: "APPLE_HEALTH" },
  ] as never);
});

describe("the dose arrival record and the credential that sent the batch", () => {
  it("is written for the phone's own session", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      session: { id: "s" },
      user: USER,
    } as never);
    const res = await postReplayedDose();
    expect(res.status).toBe(200);
    expect(recordHealthKitTypeArrivals).toHaveBeenCalledTimes(1);
  });

  it("is not written for a narrow, single-purpose credential", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      session: { id: "t" },
      user: USER,
      bearerScope: "measurements:write",
    } as never);
    const res = await postReplayedDose();
    expect(res.status).toBe(200);
    expect(recordHealthKitTypeArrivals).not.toHaveBeenCalled();
  });

  // v1.43 (ios #77) — a history catch-up records the dose arrival under
  // `lastBackfillAt` only, and does not move the sync checkpoint.
  it("passes a backfill through and leaves the checkpoint where it was", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      session: { id: "s" },
      user: USER,
    } as never);
    const res = await postReplayedDose("backfill");
    expect(res.status).toBe(200);
    expect(recordHealthKitTypeArrivals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger: "backfill" }),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("moves the checkpoint for a live sync", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      session: { id: "s" },
      user: USER,
    } as never);
    await postReplayedDose("background");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSyncedAt: expect.any(Date) }),
      }),
    );
  });
});
