import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.28.50 — `GET /api/insights/ecg/[id]` (waveform detail).
 *
 * Load-bearing behaviour under test:
 *   - ownership is narrowed IN THE where ({ id, userId }) so a foreign id
 *     is null and 404s (cross-user leak structurally impossible);
 *   - the waveform is decrypted through the real fail-closed codec
 *     (encrypt → Bytes → route → decrypt round-trip);
 *   - the ~9000-sample strip is min/max-decimated to ~2500 by default and
 *     `?full=1` returns the raw array;
 *   - the response is `no-store`.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    ecgRecording: { findFirst: vi.fn() },
  },
}));

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
import { _resetCryptoCacheForTests } from "@/lib/crypto";
import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

type Ctx = { params: Promise<{ id: string }> };
const callGet = GET as unknown as (
  req: NextRequest,
  ctx: Ctx,
) => Promise<Response>;

function makeReq(query = ""): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/insights/ecg/ecg_1${query}`),
  );
}
function ctx(id = "ecg_1"): Ctx {
  return { params: Promise.resolve({ id }) };
}

function rowWith(samples: number[]) {
  return {
    recordedAt: new Date("2026-06-01T09:15:00.000Z"),
    durationSeconds: 30,
    samplingFrequency: 300,
    averageHeartRate: 72,
    lead: null,
    rhythmClassification: "IRREGULAR",
    source: "WITHINGS",
    waveformEncrypted: encryptWaveformToBytes(samples),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  _resetCryptoCacheForTests();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("GET /api/insights/ecg/[id]", () => {
  it("narrows ownership in the where and 404s an unknown / foreign id", async () => {
    vi.mocked(prisma.ecgRecording.findFirst).mockResolvedValue(null as never);
    const res = await callGet(makeReq(), ctx("ecg_x"));
    expect(res.status).toBe(404);
    const where = vi.mocked(prisma.ecgRecording.findFirst).mock.calls[0][0]
      ?.where as { id: string; userId: string };
    expect(where).toEqual({ id: "ecg_x", userId: "user-1" });
  });

  it("decrypts the waveform and min/max-decimates the ~9000-sample strip", async () => {
    const raw = Array.from({ length: 9000 }, (_, i) =>
      Math.round(Math.sin(i / 8) * 500),
    );
    raw[4500] = 9999; // an R-wave peak that must survive
    vi.mocked(prisma.ecgRecording.findFirst).mockResolvedValue(
      rowWith(raw) as never,
    );

    const res = await callGet(makeReq(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as {
      data: {
        samples: number[];
        decimated: boolean;
        classification: string;
      };
    };
    expect(body.data.decimated).toBe(true);
    expect(body.data.samples.length).toBeLessThanOrEqual(2500);
    expect(body.data.samples.length).toBeLessThan(9000);
    // The device verdict is surfaced verbatim.
    expect(body.data.classification).toBe("IRREGULAR");
    // The peak survives the decimation (min/max, never a naive stride).
    expect(Math.max(...body.data.samples)).toBe(9999);
  });

  it("returns the raw array unchanged when ?full=1", async () => {
    const raw = Array.from({ length: 9000 }, (_, i) => i % 17);
    vi.mocked(prisma.ecgRecording.findFirst).mockResolvedValue(
      rowWith(raw) as never,
    );

    const res = await callGet(makeReq("?full=1"), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { samples: number[]; decimated: boolean };
    };
    expect(body.data.decimated).toBe(false);
    expect(body.data.samples).toEqual(raw);
  });
});
