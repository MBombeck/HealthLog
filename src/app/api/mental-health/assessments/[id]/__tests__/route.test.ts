import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/mental-health/assessments/[id]` — the per-administration detail
 * read that finally consumes `responsesEncrypted` (audit finding: the column
 * was write-only; its single reader was key rotation).
 *
 * Pins the two halves of the contract:
 *   (a) the owner's detail read decrypts the stored blob and returns the
 *       per-item answers + the unscored functional follow-up, and
 *   (b) a decrypt failure (key gap / corruption / shape drift) degrades to
 *       `items: null` + `itemsUnavailable: true` while the denormalised
 *       total / band / flag still answer — never a 500 for the whole row
 *       (the records-DTO fail-soft precedent).
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    mentalHealthAssessment: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  decryptFromBytes: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

function makeReq(
  id: string,
): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(
      new URL(`http://localhost/api/mental-health/assessments/${id}`),
      { method: "GET" },
    ),
    { params: Promise.resolve({ id }) },
  ];
}

/** A stored PHQ-9 administration as the select returns it. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mha_1",
    userId: "user-1",
    instrument: "PHQ9",
    locale: "en",
    version: "standard",
    totalScore: 10,
    severityBand: "moderate",
    item9Flagged: true,
    crisisShownAt: new Date("2026-06-28T00:00:00.000Z"),
    takenAt: new Date("2026-06-28T00:00:00.000Z"),
    createdAt: new Date("2026-06-28T00:00:00.000Z"),
    responsesEncrypted: Buffer.from("ciphertext"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
});

describe("GET /api/mental-health/assessments/[id]", () => {
  it("returns the decrypted per-item answers + functional follow-up for the owner", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      storedRow() as never,
    );
    vi.mocked(decryptFromBytes).mockReturnValue(
      JSON.stringify({
        items: [1, 1, 1, 1, 1, 1, 1, 1, 2],
        functionalDifficulty: 1,
        schema: 1,
      }),
    );

    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assessment: {
          id: string;
          totalScore: number;
          items: number[] | null;
          functionalDifficulty: number | null;
          itemsUnavailable: boolean;
        };
      };
    };
    expect(body.data.assessment.id).toBe("mha_1");
    expect(body.data.assessment.items).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(body.data.assessment.functionalDifficulty).toBe(1);
    expect(body.data.assessment.itemsUnavailable).toBe(false);
    // The denormalised score fields ride along unchanged.
    expect(body.data.assessment.totalScore).toBe(10);
  });

  it("omits functionalDifficulty as null when the stored blob has none", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      storedRow({
        instrument: "GAD7",
        totalScore: 6,
        item9Flagged: false,
      }) as never,
    );
    vi.mocked(decryptFromBytes).mockReturnValue(
      JSON.stringify({ items: [1, 2, 0, 1, 1, 1, 0], schema: 1 }),
    );

    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assessment: {
          items: number[] | null;
          functionalDifficulty: number | null;
        };
      };
    };
    expect(body.data.assessment.items).toEqual([1, 2, 0, 1, 1, 1, 0]);
    expect(body.data.assessment.functionalDifficulty).toBeNull();
  });

  it("degrades to items: null + itemsUnavailable on a decrypt failure — never a 500", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      storedRow() as never,
    );
    vi.mocked(decryptFromBytes).mockImplementation(() => {
      throw new Error("Unknown encryption key id: v9");
    });

    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assessment: {
          totalScore: number;
          items: number[] | null;
          itemsUnavailable: boolean;
        };
      };
    };
    expect(body.data.assessment.items).toBeNull();
    expect(body.data.assessment.itemsUnavailable).toBe(true);
    // The score half of the row still answers.
    expect(body.data.assessment.totalScore).toBe(10);
  });

  it("degrades on a malformed or shape-drifted plaintext (wrong item count)", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      storedRow() as never,
    );
    // 3 answers on a stored PHQ-9 row: pairing them to the 9 official item
    // texts would mislabel every answer, so the read refuses to guess.
    vi.mocked(decryptFromBytes).mockReturnValue(
      JSON.stringify({ items: [1, 2, 3], schema: 1 }),
    );

    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assessment: { items: number[] | null; itemsUnavailable: boolean };
      };
    };
    expect(body.data.assessment.items).toBeNull();
    expect(body.data.assessment.itemsUnavailable).toBe(true);
  });

  it("404s another user's row without leaking its existence", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      storedRow({ userId: "user-2" }) as never,
    );
    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(404);
    // The item content never left the guard.
    expect(decryptFromBytes).not.toHaveBeenCalled();
  });

  it("404s a missing row", async () => {
    vi.mocked(prisma.mentalHealthAssessment.findFirst).mockResolvedValue(
      null as never,
    );
    const res = await callGet(...makeReq("mha_missing"));
    expect(res.status).toBe(404);
  });

  it("returns the module 403 when the mental-health module is off", async () => {
    const { apiError } = await import("@/lib/api-response");
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError("disabled", 403, { errorCode: "module.disabled" }),
    });
    const res = await callGet(...makeReq("mha_1"));
    expect(res.status).toBe(403);
    expect(prisma.mentalHealthAssessment.findFirst).not.toHaveBeenCalled();
  });
});
