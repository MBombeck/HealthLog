import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { apiError } from "@/lib/api-response";
import type { DailyDigest } from "@/lib/daily/digest";
import { SCORE_VERSION } from "@/lib/analytics/score/types";

/**
 * `GET /api/daily/digest` — the P3 read seam.
 *
 * Under test: cookie/Bearer auth narrows the user, the `insights` module (the
 * AI analysis opt-out) no longer refuses the digest, and the happy path
 * returns the `DailyDigest` DTO shape. The digest
 * itself is composed by `loadDailyDigest`, mocked here — the route must reach
 * no provider (there is nothing AI-shaped in this module graph).
 */

vi.mock("@/lib/db", () => ({
  prisma: { appSettings: { findUnique: vi.fn().mockResolvedValue(null) } },
}));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/daily/load-digest", () => ({ loadDailyDigest: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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
import { requireModuleEnabled } from "@/lib/modules/gate";
import { loadDailyDigest } from "@/lib/daily/load-digest";
import { DIGEST_AI_AVAILABLE } from "@/__tests__/helpers/ai-capability-fixtures";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    locale: "en",
  },
};

const DIGEST: DailyDigest = {
  generatedAt: "2026-07-16T09:00:00.000Z",
  ai: DIGEST_AI_AVAILABLE,
  phase: "final",
  sleepPending: false,
  score: {
    value: 82,
    band: "good",
    delta: 3,
    deltaReason: null,
    scoreVersion: SCORE_VERSION,
    composition: ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
  },
  topSignal: null,
  briefingLead: "Blood pressure is holding steady.",
  lead: { text: "Blood pressure is holding steady.", source: "briefing" },
  today: [],
  restMode: null,
  line: "Blood pressure is holding steady.",
  worthALook: [],
  justIn: null,
  reactionLine: null,
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(new URL("http://localhost/api/daily/digest"));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(loadDailyDigest).mockResolvedValue(DIGEST);
});

describe("GET /api/daily/digest", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(401);
    expect(vi.mocked(loadDailyDigest)).not.toHaveBeenCalled();
  });

  it("serves the digest with the insights module (the AI analysis opt-out) off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "insights",
      }),
    });
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    expect(vi.mocked(requireModuleEnabled)).not.toHaveBeenCalled();
    expect(vi.mocked(loadDailyDigest)).toHaveBeenCalled();
  });

  it("returns 200 with the DailyDigest DTO on the happy path", async () => {
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(body.data).toEqual(DIGEST);
    expect(vi.mocked(loadDailyDigest)).toHaveBeenCalledOnce();
  });
});
