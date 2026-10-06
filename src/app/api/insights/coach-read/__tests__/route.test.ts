import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The route has to say who is reading.
 *
 * The strip's second line is a finished sentence written server-side. The
 * builder can write it in any of the six languages; for months it wrote
 * English on a German page because this route never passed a language and the
 * engine underneath quietly defaulted. So what is pinned here is the handoff
 * itself: the resolved locale reaching `buildCoachReadStrip`, from the cookie a
 * language switch sets and from the stored preference when there is no cookie.
 */

const buildCoachReadStrip = vi.fn();
const zoneSeen = vi.fn();
vi.mock("@/lib/insights/derived/coach-read", () => ({
  buildCoachReadStrip: (
    userId: string,
    metric: string,
    locale: string,
    opts: { tz: string },
  ) => {
    zoneSeen(opts.tz);
    return buildCoachReadStrip(userId, metric, locale);
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAnalyticsReadRateLimit: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const localeCookie = vi.fn<() => string | undefined>(() => undefined);
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "healthlog-locale" && localeCookie() !== undefined
        ? { value: localeCookie() }
        : undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";

function sessionWithLocale(locale: string | null, timezone?: string) {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "testuser",
      role: "USER" as const,
      locale,
      ...(timezone ? { timezone } : {}),
    },
  };
}

const REQUEST = () =>
  new NextRequest("http://localhost/api/insights/coach-read?metric=WEIGHT");

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue(
    sessionWithLocale(null) as unknown as Awaited<
      ReturnType<typeof getSession>
    >,
  );
  vi.mocked(checkAnalyticsReadRateLimit).mockResolvedValue({
    allowed: true,
  } as unknown as Awaited<ReturnType<typeof checkAnalyticsReadRateLimit>>);
  buildCoachReadStrip.mockReset().mockResolvedValue({
    baseline: null,
    learning: true,
    driver: null,
  });
  localeCookie.mockReturnValue(undefined);
});

describe("GET /api/insights/coach-read — the reader's language", () => {
  it("passes the language the switcher's cookie names", async () => {
    localeCookie.mockReturnValue("de");

    const res = await GET(REQUEST());

    expect(res.status).toBe(200);
    expect(buildCoachReadStrip).toHaveBeenCalledWith("user-1", "WEIGHT", "de");
  });

  it("falls back to the stored preference when there is no cookie", async () => {
    vi.mocked(getSession).mockResolvedValue(
      sessionWithLocale("fr") as unknown as Awaited<
        ReturnType<typeof getSession>
      >,
    );

    await GET(REQUEST());

    expect(buildCoachReadStrip).toHaveBeenCalledWith("user-1", "WEIGHT", "fr");
  });

  it("never hard-codes a language of its own", async () => {
    // Two readers, two languages, from the same handler. A route that pinned
    // one would pass this only by accident.
    localeCookie.mockReturnValue("es");
    await GET(REQUEST());
    localeCookie.mockReturnValue("de");
    await GET(REQUEST());

    expect(buildCoachReadStrip.mock.calls.map((call) => call[2])).toEqual([
      "es",
      "de",
    ]);
  });
});

describe("GET /api/insights/coach-read — the reader's day", () => {
  it("passes the reader's own zone, which decides whether a day is still in progress", async () => {
    vi.mocked(getSession).mockResolvedValue(
      sessionWithLocale(null, "America/New_York") as unknown as Awaited<
        ReturnType<typeof getSession>
      >,
    );
    zoneSeen.mockReset();

    const res = await GET(REQUEST());

    expect(res.status).toBe(200);
    expect(zoneSeen).toHaveBeenCalledWith("America/New_York");
  });
});
