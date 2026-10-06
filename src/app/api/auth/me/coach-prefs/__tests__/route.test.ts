/**
 * v1.32.22 (M4) — `PUT /api/auth/me/coach-prefs` optimistic concurrency.
 *
 * A full-replace endpoint hydrated from a stale GET (two tabs / two devices)
 * clobbers silently; the base token 409s that. The guarded write covers BOTH
 * `coachPrefsJson` AND the mirrored `insightsExcludeMetrics` column in one
 * conditional update, so a 409 leaves both untouched together. A tokenless PUT
 * keeps the prior unconditional write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function mkPut(body: unknown): Request {
  return new Request("http://localhost/api/auth/me/coach-prefs", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/auth/me/coach-prefs", () => {
  it("returns a SAVED user's prefs plus the optimistic-concurrency token", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      coachPrefsJson: { tone: "concise" },
      updatedAt: new Date("2026-07-24T10:00:00.000Z"),
    } as never);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { tone: string; updatedAt?: string };
    };
    expect(env.data.tone).toBe("concise");
    expect(env.data.updatedAt).toBe("2026-07-24T10:00:00.000Z");
  });

  it("returns the PURE default with NO token for a never-saved user", async () => {
    // Mirrors the insights-layout never-saved GET: nothing to guard yet, and
    // the first save is the tokenless unconditional write (backward-compat).
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      coachPrefsJson: null,
      updatedAt: new Date("2026-07-24T10:00:00.000Z"),
    } as never);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const env = (await res.json()) as {
      data: { tone: string; updatedAt?: string };
    };
    expect(env.data.tone).toBe("warm");
    expect(env.data.updatedAt).toBeUndefined();
  });
});

describe("PUT /api/auth/me/coach-prefs — optimistic concurrency", () => {
  it("guards both columns in one conditional write and echoes the token", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      updatedAt: new Date("2026-07-24T10:05:00.000Z"),
    } as never);
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({
        excludeMetrics: ["weight"],
        baseUpdatedAt: "2026-07-24T10:00:00.000Z",
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0] as {
      where: { id: string; updatedAt: Date };
      data: { coachPrefsJson: unknown; insightsExcludeMetrics: string[] };
    };
    expect((call.where.updatedAt as Date).toISOString()).toBe(
      "2026-07-24T10:00:00.000Z",
    );
    // Both mirror columns ride the SAME guarded update.
    expect(call.data.coachPrefsJson).toBeTruthy();
    expect(call.data.insightsExcludeMetrics).toEqual(["weight"]);
    expect(prisma.user.update).not.toHaveBeenCalled();
    const env = (await res.json()) as { data: { updatedAt: string } };
    expect(env.data.updatedAt).toBe("2026-07-24T10:05:00.000Z");
  });

  it("interleaved writers: a stale token 409s and leaves BOTH columns untouched", async () => {
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({
        excludeMetrics: ["weight"],
        baseUpdatedAt: "2026-07-24T08:00:00.000Z",
      }),
    );
    expect(res.status).toBe(409);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("coach_prefs_conflict");
    // Nothing written — the single guarded update matched no row.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the token is omitted (compat)", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ excludeMetrics: ["weight"] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      data: { coachPrefsJson: unknown; insightsExcludeMetrics: string[] };
    };
    expect(call.data.insightsExcludeMetrics).toEqual(["weight"]);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ excludeMetrics: ["weight"], baseUpdatedAt: "not-a-date" }),
    );
    expect(res.status).toBe(422);
    const env = (await res.json()) as { meta?: { errorCode?: string } };
    expect(env.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/auth/me/coach-prefs — thinking depth (v1.41)", () => {
  it("stores the chosen level and names it on the wide event", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-10-06T11:00:00.000Z"),
    } as never);
    const { annotate } = await import("@/lib/logging/context");

    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ reasoning: "high" }),
    );
    expect(res.status).toBe(200);
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as {
      data: { coachPrefsJson: { reasoning?: string } };
    };
    expect(call.data.coachPrefsJson.reasoning).toBe("high");
    const env = (await res.json()) as { data: { reasoning?: string } };
    expect(env.data.reasoning).toBe("high");
    const meta = vi
      .mocked(annotate)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action?.name === "auth.me.coach-prefs.put")?.meta;
    expect(meta).toMatchObject({ reasoning: "high" });
  });

  it("reads an absent level as the default on the wide event", async () => {
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-10-06T11:00:00.000Z"),
    } as never);
    const { annotate } = await import("@/lib/logging/context");

    await (PUT as (r: Request) => Promise<Response>)(mkPut({ tone: "warm" }));
    const meta = vi
      .mocked(annotate)
      .mock.calls.map((c) => c[0])
      .find((a) => a.action?.name === "auth.me.coach-prefs.put")?.meta;
    expect(meta).toMatchObject({ reasoning: "medium" });
  });

  it.each(["xhigh", "none", 2, null])("422s %s as a level", async (value) => {
    const res = await (PUT as (r: Request) => Promise<Response>)(
      mkPut({ reasoning: value }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
