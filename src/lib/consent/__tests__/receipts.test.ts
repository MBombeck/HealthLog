import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    consentReceipt: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import {
  createReceipt,
  latestActiveReceipt,
  latestActiveReceiptsByKind,
  revokeLatest,
} from "../receipts";

beforeEach(() => {
  vi.resetAllMocks();
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rcpt-1",
    userId: "user-1",
    kind: "ai_full",
    artefact: "PDF…",
    signedAt: new Date("2026-05-18T10:00:00.000Z"),
    revokedAt: null,
    createdAt: new Date("2026-05-18T10:00:01.000Z"),
    ...overrides,
  };
}

describe("createReceipt", () => {
  it("inserts a row scoped to (userId, kind) with the artefact + signedAt", async () => {
    vi.mocked(prisma.consentReceipt.create).mockResolvedValue(row() as never);

    const signedAt = new Date("2026-05-18T10:00:00.000Z");
    const result = await createReceipt("user-1", "ai_full", "PDF…", signedAt);

    expect(prisma.consentReceipt.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        kind: "ai_full",
        artefact: "PDF…",
        signedAt,
      },
    });
    expect(result.id).toBe("rcpt-1");
  });
});

describe("latestActiveReceipt", () => {
  it("filters by user + kind + revokedAt:null and orders by createdAt desc", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(row() as never);

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(prisma.consentReceipt.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", kind: "ai_full", revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(result?.id).toBe("rcpt-1");
  });

  it("returns null when no active receipt exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const result = await latestActiveReceipt("user-1", "ai_full");

    expect(result).toBeNull();
  });
});

describe("latestActiveReceiptsByKind", () => {
  it("returns the freshest row per kind (first-wins over createdAt desc)", async () => {
    vi.mocked(prisma.consentReceipt.findMany).mockResolvedValue([
      row({ id: "fresh-coach", kind: "ai_coach" }),
      row({ id: "fresh-full", kind: "ai_full" }),
      // Older `ai_full` row — must be ignored because we already saw
      // the freshest one above (the mock list is pre-sorted desc).
      row({ id: "older-full", kind: "ai_full" }),
    ] as never);

    const result = await latestActiveReceiptsByKind("user-1");

    expect(result.ai_full?.id).toBe("fresh-full");
    expect(result.ai_coach?.id).toBe("fresh-coach");
    expect(result.ai_insights_only).toBeUndefined();
  });
});

describe("revokeLatest", () => {
  it("flips revokedAt on the latest active row and returns the updated row", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(row() as never);
    vi.mocked(prisma.consentReceipt.update).mockResolvedValue(
      row({ revokedAt: new Date("2026-05-18T11:00:00.000Z") }) as never,
    );

    const now = new Date("2026-05-18T11:00:00.000Z");
    const result = await revokeLatest("user-1", "ai_full", now);

    expect(prisma.consentReceipt.update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { revokedAt: now },
    });
    expect(result?.revokedAt).toEqual(now);
  });

  it("returns null without writing when no active receipt exists", async () => {
    vi.mocked(prisma.consentReceipt.findFirst).mockResolvedValue(null);

    const result = await revokeLatest("user-1", "ai_full");

    expect(result).toBeNull();
    expect(prisma.consentReceipt.update).not.toHaveBeenCalled();
  });
});
