import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `POST /api/insights/pregenerate` warms two AI capabilities, `briefing` and
 * `statusText`. It returns no model output, so it never refuses: with
 * neither available it answers 200 `{ queued: false }` and enqueues nothing;
 * with either available it enqueues (the worker checks each half). The `ai`
 * block always says which half can run.
 */

vi.mock("@/lib/db", () => ({ prisma: {} }));

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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

// Stub the worker enqueue so the route test stays isolated from pg-boss.
vi.mock("@/lib/jobs/insight-pregenerate-shared", () => ({
  enqueueForceWarm: vi.fn(async () => undefined),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({ getAiCapability: vi.fn() }));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";
import {
  AI_AVAILABLE,
  aiUnavailable,
} from "@/__tests__/helpers/ai-capability-fixtures";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callPost = POST as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(new URL("http://localhost/api/insights/pregenerate"), {
    method: "POST",
  });
}

function capabilities(
  states: Partial<Record<AiCapabilityKey, ReturnType<typeof aiUnavailable>>>,
) {
  vi.mocked(getAiCapability).mockImplementation(
    async (key) => states[key] ?? AI_AVAILABLE,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  capabilities({});
});

describe("POST /api/insights/pregenerate", () => {
  it("enqueues a warm when both halves are available", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await callPost(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { queued: boolean; ai: Record<string, unknown> } | null;
      error: string | null;
    };
    expect(body.error).toBeNull();
    expect(body.data?.queued).toBe(true);
    expect(body.data?.ai).toEqual({
      briefing: AI_AVAILABLE,
      statusText: AI_AVAILABLE,
    });
    expect(enqueueForceWarm).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("enqueues when only one half is available (the worker skips the other)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    capabilities({ briefing: aiUnavailable("operator_disabled") });
    const res = await callPost(makeReq());
    expect(res.status).toBe(200);
    expect(enqueueForceWarm).toHaveBeenCalledTimes(1);
  });

  it.each([
    "operator_disabled",
    "user_disabled",
    "no_provider",
    "consent_required",
  ] as const)(
    "answers 200 { queued: false } and enqueues nothing when neither half is available (%s)",
    async (reason) => {
      vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
      capabilities({
        briefing: aiUnavailable(reason),
        statusText: aiUnavailable(reason),
      });
      const res = await callPost(makeReq());
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { queued: boolean; ai: { briefing: { reason: string } } };
      };
      expect(body.data.queued).toBe(false);
      expect(body.data.ai.briefing.reason).toBe(reason);
      expect(enqueueForceWarm).not.toHaveBeenCalled();
      // Nothing to warm, so no anti-spam bucket is spent either.
      expect(checkRateLimit).not.toHaveBeenCalled();
    },
  );

  it("401s when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callPost(makeReq());
    expect(res.status).toBe(401);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });
});
