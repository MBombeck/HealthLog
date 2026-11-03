import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.28.50 — `GET /api/insights/ecg` (metadata-only recording list).
 *
 * Load-bearing behaviour under test: it narrows the query to the session
 * user, NEVER selects the encrypted waveform, returns the device's own
 * classification per row, and reports `hasRecordings: false` (the
 * data-availability gate the UI keys off) when the user has none.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    ecgRecording: { findMany: vi.fn() },
  },
}));

// Module gate mocked default-enabled; the off → 403 coverage lives in the
// module-route-gate inventory test (the route calls requireModuleEnabled).
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
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

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(new URL("http://localhost/api/insights/ecg"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/insights/ecg", () => {
  it("returns hasRecordings:false with an empty list when the user has none", async () => {
    vi.mocked(prisma.ecgRecording.findMany).mockResolvedValue([] as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { recordings: unknown[]; hasRecordings: boolean };
    };
    expect(body.data.hasRecordings).toBe(false);
    expect(body.data.recordings).toEqual([]);
  });

  it("narrows the query to the session user and never selects the waveform", async () => {
    vi.mocked(prisma.ecgRecording.findMany).mockResolvedValue([] as never);
    await callGet(makeReq());
    const arg = vi.mocked(prisma.ecgRecording.findMany).mock.calls[0][0] as {
      where: { userId: string };
      select: Record<string, boolean>;
    };
    expect(arg.where.userId).toBe("user-1");
    // The encrypted blob must never be pulled into the list read.
    expect(arg.select.waveformEncrypted).toBeUndefined();
    expect(arg.select.id).toBe(true);
    expect(arg.select.rhythmClassification).toBe(true);
  });

  it("maps each row to metadata + the device verdict, flagging hasWaveform", async () => {
    vi.mocked(prisma.ecgRecording.findMany).mockResolvedValue([
      {
        id: "ecg_1",
        recordedAt: new Date("2026-06-01T09:15:00.000Z"),
        durationSeconds: 30,
        samplingFrequency: 300,
        sampleCount: 9000,
        averageHeartRate: 72,
        lead: null,
        rhythmClassification: "IRREGULAR",
        source: "WITHINGS",
      },
      {
        id: "ecg_2",
        recordedAt: new Date("2026-05-01T09:15:00.000Z"),
        durationSeconds: null,
        samplingFrequency: 0,
        sampleCount: 0,
        averageHeartRate: null,
        lead: null,
        rhythmClassification: "NOT_DETECTED",
        source: "WITHINGS",
      },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        hasRecordings: boolean;
        recordings: Array<{
          id: string;
          classification: string | null;
          hasWaveform: boolean;
          recordedAt: string;
        }>;
      };
    };
    expect(body.data.hasRecordings).toBe(true);
    expect(body.data.recordings[0]).toMatchObject({
      id: "ecg_1",
      classification: "IRREGULAR",
      hasWaveform: true,
      recordedAt: "2026-06-01T09:15:00.000Z",
    });
    // A verdict-only fallback (sampleCount 0) reports hasWaveform:false.
    expect(body.data.recordings[1].hasWaveform).toBe(false);
    expect(body.data.recordings[1].classification).toBe("NOT_DETECTED");
  });
});
