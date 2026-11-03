import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.32.21 — optimistic concurrency on `PUT /api/coach/about-me`
 * (issue #581 family). The write guards on `UserHealthProfile.updatedAt`:
 *
 *   - a stale base token → 409 `about_me_conflict`, no write;
 *   - a matched base token → conditional update, fresh token echoed;
 *   - a zero-match against a MISSING row → create wins (nothing to clobber);
 *   - a tokenless request → the prior unconditional upsert (iOS-compat arm).
 *
 * Mirrors the mock scaffolding of `route-module-gate.test.ts`.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
}));

const { requireModuleEnabled } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  getClientIp: () => "127.0.0.1",
  returnAllZodIssues: (_e: unknown, status: number) => ({
    data: null,
    error: "validation",
    status,
  }),
  safeJson: async (req: Request) => ({ data: await req.json(), error: null }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

const { profile, userUpdate, transaction } = vi.hoisted(() => {
  const profile = {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const userUpdate = vi.fn(async () => ({}));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    userHealthProfile: profile,
    user: { update: userUpdate },
  };
  return {
    profile,
    userUpdate,
    transaction: vi.fn(async (callback: (client: unknown) => unknown) =>
      callback(tx),
    ),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: transaction,
    userHealthProfile: profile,
    user: { update: userUpdate },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => Buffer.from(s),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextForUser: vi.fn(async () => ({
    aboutMe: null,
    conditions: null,
    allergies: null,
    coachFocus: null,
  })),
  filterSelfContextForAi: (ctx: Record<string, string | null>) => ctx,
  getPendingQuestionsForUser: vi.fn(async () => []),
  setPendingQuestionsForUser: vi.fn(async () => true),
}));
vi.mock("@/lib/ai/coach/self-context-questions", () => ({
  deriveClarifyingQuestions: vi.fn(async () => ({
    questions: [],
    source: "none",
  })),
}));

import { PUT } from "../route";
import {
  getPendingQuestionsForUser,
  getSelfContextForUser,
  setPendingQuestionsForUser,
} from "@/lib/ai/coach/about-me";
import { deriveClarifyingQuestions } from "@/lib/ai/coach/self-context-questions";

type Envelope = {
  data: {
    updatedAt?: string;
    pendingQuestions?: string[];
    aiIncludedSections?: string[];
  } | null;
  error: string | null;
  status: number;
  meta?: { errorCode?: string };
};
const put = PUT as unknown as (req: Request) => Promise<Envelope>;

function putReq(
  baseUpdatedAt?: string,
  overrides: Record<string, unknown> = {},
): Request {
  return new Request("http://localhost/api/coach/about-me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      aboutMe: "I run daily",
      ...overrides,
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    }),
  });
}

beforeEach(() => {
  // Reset, not clear: cases replace the profile reads and the question store
  // with their own implementations, and a cleared mock keeps them. A reset
  // mock returns to the implementation it was created with.
  vi.resetAllMocks();
  requireModuleEnabled.mockResolvedValue({ enabled: true });
});

describe("about-me — optimistic concurrency", () => {
  it("guards on the base token and echoes the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    profile.updateMany.mockResolvedValue({ count: 1 });
    profile.findUnique.mockResolvedValue({ updatedAt: advanced });

    const res = await put(putReq(base.toISOString()));
    expect(res.status).toBe(200);

    // Conditional write on the exact base token — never the upsert.
    expect(profile.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = profile.updateMany.mock.calls[0]?.[0]?.where as {
      userId: string;
      updatedAt: Date;
    };
    expect(whereArg.userId).toBe("u1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(res.data?.updatedAt).toBe(advanced.toISOString());
  });

  it("returns the post-question token so the next guarded write can use it", async () => {
    const afterProfileWrite = new Date("2026-07-24T10:05:00.000Z");
    const afterQuestions = new Date("2026-07-24T10:06:00.000Z");
    const secondProfileWrite = new Date("2026-07-24T10:07:00.000Z");
    const secondQuestions = new Date("2026-07-24T10:08:00.000Z");
    profile.upsert.mockResolvedValue({ updatedAt: afterProfileWrite });
    profile.updateMany.mockResolvedValue({ count: 1 });
    profile.findUnique
      .mockResolvedValueOnce({
        updatedAt: afterProfileWrite,
        aiIncludedSections: ["ABOUT_ME"],
      })
      .mockResolvedValueOnce({ updatedAt: afterQuestions })
      .mockResolvedValueOnce({ updatedAt: secondProfileWrite })
      .mockResolvedValueOnce({
        updatedAt: secondProfileWrite,
        aiIncludedSections: ["ABOUT_ME"],
      })
      .mockResolvedValueOnce({ updatedAt: secondQuestions });

    const first = await put(putReq());
    expect(first.data?.updatedAt).toBe(afterQuestions.toISOString());

    const second = await put(putReq(first.data?.updatedAt));
    expect(second.status).toBe(200);
    expect(profile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", updatedAt: afterQuestions },
      }),
    );
    expect(second.data?.updatedAt).toBe(secondQuestions.toISOString());
  });

  it("a stale inclusion save 409s before it can clobber newer About Me text", async () => {
    profile.updateMany.mockResolvedValue({ count: 0 });
    profile.findUnique.mockResolvedValue({
      updatedAt: new Date("2026-07-24T10:05:00.000Z"),
    });

    const res = await put(
      putReq("2026-07-24T09:00:00.000Z", {
        aboutMe: "stale text from the inclusion manager",
        aiIncludedSections: ["ABOUT_ME"],
      }),
    );
    expect(res.status).toBe(409);
    expect(res.data).toBeNull();
    expect(res.meta?.errorCode).toBe("about_me_conflict");
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(profile.create).not.toHaveBeenCalled();
  });

  it("a zero-match against a MISSING row creates instead of 409ing", async () => {
    profile.updateMany.mockResolvedValue({ count: 0 });
    profile.findUnique.mockResolvedValue(null);
    profile.create.mockResolvedValue({
      updatedAt: new Date("2026-07-24T12:00:00.000Z"),
    });

    const res = await put(putReq("2026-07-24T09:00:00.000Z"));
    expect(res.status).toBe(200);
    expect(profile.create).toHaveBeenCalledTimes(1);
    expect(res.data?.updatedAt).toBe("2026-07-24T12:00:00.000Z");
  });

  it("updates inclusion controls without rewriting encrypted profile text", async () => {
    profile.upsert.mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    });

    const res = await put(
      putReq(undefined, {
        aboutMe: undefined,
        aiIncludedSections: ["CONDITIONS"],
      }),
    );

    expect(res.status).toBe(200);
    const write = profile.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(write.create).not.toHaveProperty("aboutMeEncrypted");
    expect(write.update).not.toHaveProperty("aboutMeEncrypted");
    expect(write.update.aiIncludedSections).toEqual(["CONDITIONS"]);
  });

  it("keeps the unconditional upsert when the token is omitted (iOS compat)", async () => {
    profile.upsert.mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    });

    const res = await put(putReq());
    expect(res.status).toBe(200);
    expect(profile.upsert).toHaveBeenCalledTimes(1);
    expect(profile.updateMany).not.toHaveBeenCalled();
    expect(res.data?.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });

  it("rejects an empty update without touching the row", async () => {
    const res = await put(putReq(undefined, { aboutMe: undefined }));

    expect(res.status).toBe(422);
    expect(profile.upsert).not.toHaveBeenCalled();
    expect(profile.updateMany).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await put(putReq("not-a-date"));
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(profile.updateMany).not.toHaveBeenCalled();
    expect(profile.upsert).not.toHaveBeenCalled();
  });
  it("does not let a stale derivation overwrite newer scoped questions", async () => {
    const versionA = new Date("2026-07-24T10:00:00.000Z");
    const versionB = new Date("2026-07-24T10:01:00.000Z");
    const staleQuestions = ["What does your running routine look like?"];
    const newerQuestions = ["How is asthma affecting you today?"];
    let currentUpdatedAt = versionA;
    let currentSections = ["ABOUT_ME"];
    let storedQuestions = [] as string[];

    profile.upsert.mockResolvedValue({ updatedAt: versionA });
    profile.findUnique.mockImplementation(
      async (args: { select: Record<string, boolean> }) =>
        args.select.aiIncludedSections
          ? { aiIncludedSections: currentSections }
          : { updatedAt: currentUpdatedAt },
    );
    vi.mocked(getSelfContextForUser).mockResolvedValueOnce({
      aboutMe: "I run daily",
      conditions: null,
      allergies: null,
      coachFocus: null,
    });
    vi.mocked(getPendingQuestionsForUser).mockImplementation(
      async () => storedQuestions,
    );
    vi.mocked(setPendingQuestionsForUser).mockImplementation(
      async (_userId, questions, expectedUpdatedAt) => {
        if (
          expectedUpdatedAt === undefined ||
          expectedUpdatedAt.getTime() !== currentUpdatedAt.getTime()
        ) {
          return false;
        }
        storedQuestions = questions ?? [];
        return true;
      },
    );

    let markDerivationStarted!: () => void;
    const derivationStarted = new Promise<void>((resolve) => {
      markDerivationStarted = resolve;
    });
    let finishDerivation!: (value: {
      questions: string[];
      source: "ai";
    }) => void;
    const derivationFinished = new Promise<{
      questions: string[];
      source: "ai";
    }>((resolve) => {
      finishDerivation = resolve;
    });
    vi.mocked(deriveClarifyingQuestions).mockImplementationOnce(async () => {
      markDerivationStarted();
      return derivationFinished;
    });

    const requestA = put(
      putReq(undefined, { aiIncludedSections: ["ABOUT_ME"] }),
    );
    await derivationStarted;

    currentUpdatedAt = versionB;
    currentSections = ["CONDITIONS"];
    storedQuestions = newerQuestions;
    finishDerivation({ questions: staleQuestions, source: "ai" });

    const responseA = await requestA;

    expect(setPendingQuestionsForUser).toHaveBeenCalledWith(
      "u1",
      staleQuestions,
      versionA,
    );
    expect(storedQuestions).toEqual(newerQuestions);
    expect(getPendingQuestionsForUser).toHaveBeenCalledWith("u1");
    expect(responseA.data?.pendingQuestions).toEqual(newerQuestions);
  });
});
