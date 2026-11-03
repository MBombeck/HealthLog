import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The cycle insights route has to say who is reading, too.
 *
 * Each surviving lagged row carries a finished `interpretation` sentence that
 * this route serves straight to the client. The engine underneath can write it
 * in any of the six languages, and it only writes the right one if the route
 * resolves the reader's language and hands it over — the same handoff the
 * metric page's "Coach read" strip was missing when it answered a German page
 * in English.
 *
 * So what is pinned here is the handoff itself: the resolved locale arriving at
 * `discoverPhaseCorrelations`, from the cookie a language switch sets and from
 * the stored preference when there is no cookie. Without this the route could
 * go back to naming one language outright and nothing in the suite would
 * notice.
 */

/** Stands in for the discovery engine so the ARGUMENTS are what is inspected. */
const discoverPhaseCorrelations = vi.fn<
  (args: { locale?: unknown }) => {
    discovered: never[];
    pairsTested: number;
    fdrQ: number;
    minPairs: number;
  }
>(() => ({
  discovered: [],
  pairsTested: 0,
  fdrQ: 0.1,
  minPairs: 20,
}));
vi.mock("@/lib/cycle/phase-crosstab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cycle/phase-crosstab")>()),
  discoverPhaseCorrelations: (args: { locale?: unknown }) =>
    discoverPhaseCorrelations(args),
}));

vi.mock("@/lib/measurements/day-aggregates", () => ({
  readSourceDayAggregates: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
    cycleDayLog: { findMany: vi.fn().mockResolvedValue([]) },
    measurement: { findMany: vi.fn().mockResolvedValue([]) },
    moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findUnique: vi.fn().mockResolvedValue({ sourcePriorityJson: null }),
    },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cycle/gate", () => ({
  requireCycleEnabled: vi.fn(async () => ({
    enabled: true,
    profile: { lutealPhaseLength: 14, averageCycleLength: 28 },
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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

function sessionWithLocale(locale: string | null) {
  return {
    session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: {
      id: "user-1",
      username: "testuser",
      role: "USER" as const,
      gender: "FEMALE" as const,
      timezone: "Europe/Berlin",
      locale,
    },
  };
}

beforeEach(() => {
  vi.mocked(getSession).mockResolvedValue(
    sessionWithLocale(null) as unknown as Awaited<
      ReturnType<typeof getSession>
    >,
  );
  discoverPhaseCorrelations.mockClear();
  localeCookie.mockReturnValue(undefined);
});

/** The locale the route handed the discovery engine on the last call. */
function passedLocale(): unknown {
  return discoverPhaseCorrelations.mock.calls.at(-1)?.[0]?.locale;
}

describe("GET /api/cycle/insights — the reader's language", () => {
  it("passes the language the switcher's cookie names", async () => {
    localeCookie.mockReturnValue("de");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(passedLocale()).toBe("de");
  });

  it("falls back to the stored preference when there is no cookie", async () => {
    vi.mocked(getSession).mockResolvedValue(
      sessionWithLocale("pl") as unknown as Awaited<
        ReturnType<typeof getSession>
      >,
    );

    await GET();

    expect(passedLocale()).toBe("pl");
  });

  it("never hard-codes a language of its own", async () => {
    // Two readers, two languages, from the same handler. A route that named
    // one outright would pass this only by accident.
    localeCookie.mockReturnValue("it");
    await GET();
    const first = passedLocale();
    localeCookie.mockReturnValue("fr");
    await GET();

    expect([first, passedLocale()]).toEqual(["it", "fr"]);
  });
});
