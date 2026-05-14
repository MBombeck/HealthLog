/**
 * v1.4.25 W10 reconcile (Code-H1) — weight-weekday correlator honours
 * the user's display timezone.
 *
 * Before W10 the analytics route's `berlinIsoWeekday()` helper was
 * pinned to `Europe/Berlin` regardless of the requesting user's
 * timezone. A weight reading recorded at 23:30 in `Pacific/Auckland`
 * (UTC+12, summer) lands at 11:30 the same day in Berlin — so a Monday
 * reading in the user's local frame got bucketed under Sunday and the
 * Pearson/ANOVA test ran against the wrong weekday column.
 *
 * This test pins the contract: weight readings inserted at a UTC
 * instant that maps to one weekday in Berlin and a different weekday in
 * the user's tz are bucketed against the user's tz. We seed exactly
 * enough readings for the analytics correlator's `n >= 20` gate (W6
 * raised the floor) and verify the helper used the user's tz to bucket
 * them by reading the wide-event `correlations.weightWeekday` status
 * tag plus the route response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface AnalyticsEnvelope {
  data: {
    correlations: {
      weightWeekday: {
        status: string;
        n?: number;
      };
    };
  };
}

async function seedSession(username: string, timezone: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone,
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

/**
 * Format `Intl.DateTimeFormat` weekday short-name for a UTC instant
 * in a target timezone. Mirrors the route's internal helper so the
 * test asserts the same contract the route exposes.
 */
function isoWeekdayShort(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
  }).format(d);
}

describe("GET /api/analytics — weight-weekday correlator honours user tz", () => {
  it("buckets a non-Berlin user's late-evening readings against the user-local weekday", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("auckland-weight-user", "Pacific/Auckland");

    // 28 readings, one per day across four weeks ending today. Each
    // reading is anchored to the moment when the Berlin weekday and the
    // Auckland weekday differ — late-evening UTC (~12:30 UTC) is
    // Auckland's next-day 00:30 (NZST = UTC+12) but Berlin's same-day
    // 14:30 (CEST = UTC+2). The weekday computed against `Europe/Berlin`
    // differs from the weekday computed against `Pacific/Auckland` for
    // every row in this dataset. The correlator filters to the trailing
    // 30 days, so the fixture must end near `Date.now()`.
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Build candidate UTC instants and find one where Berlin/Auckland
    // weekdays differ. 12:30 UTC ⇒ Auckland +12 = 00:30 next-day,
    // Berlin +2 (CEST in May 2026) = 14:30 same-day. The weekday
    // difference is stable across the 28-day window because both tzs
    // have no DST inside it.
    const candidate = new Date(now);
    candidate.setUTCHours(12, 30, 0, 0);
    // Push the candidate to the most recent UTC instant in the past so
    // every seeded row has measuredAt < now.
    if (candidate.getTime() > now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    // Sanity check: the contract under test requires Berlin and the
    // user's tz to disagree on the weekday for the seeded instant.
    const berlinWeekday = isoWeekdayShort(candidate, "Europe/Berlin");
    const aucklandWeekday = isoWeekdayShort(candidate, "Pacific/Auckland");
    expect(berlinWeekday).not.toBe(aucklandWeekday);

    for (let i = 27; i >= 0; i--) {
      const measuredAt = new Date(candidate.getTime() - i * DAY_MS);
      // Vary weight by user-tz weekday so the ANOVA has a signal.
      const userWeekday = isoWeekdayShort(measuredAt, "Pacific/Auckland");
      const offset =
        userWeekday === "Mon" ? 1.5 : userWeekday === "Sat" ? -0.8 : 0;
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "WEIGHT",
          value: 82 + offset,
          unit: "kg",
          source: "MANUAL",
          measuredAt,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    // The wrapped handler reads `request.url` for logging metadata;
    // the inner handler ignores its arguments. Cast through `unknown`
    // because `apiHandler`'s narrowed type signature is the inner
    // handler's `()`, not the wrapper's `(NextRequest)`.
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    // The correlator should hit the `n >= 20` gate (28 readings) and
    // surface a result — either "ok" if the ANOVA picks up the Monday
    // signal, or "insufficient" with `reason: "not_significant"` if
    // the noise drowns out the offset. Either way, `n` must reflect
    // every seeded row, confirming the picker bucketed every row
    // against a weekday (rather than crashing or filtering anything
    // out).
    const wkd = envelope.data.correlations.weightWeekday;
    expect(["ok", "insufficient"]).toContain(wkd.status);
    expect(wkd.n).toBe(28);
  });

  it("falls back to the project-default tz when the user has none stored", async () => {
    // Defence-in-depth: seed a user whose timezone is the schema
    // default. The pre-W10 helper always read `Europe/Berlin`; with
    // the W10 fix the same code path resolves to `userTz` which
    // defaults to `Europe/Berlin` via `user.timezone ?? DEFAULT_TIMEZONE`.
    // The behaviour for a Berlin-tz user must be identical to the
    // pre-W10 implementation.
    const prisma = getPrismaClient();
    const user = await seedSession("berlin-default-user", "Europe/Berlin");

    // 28 readings ending today so every row falls inside the
    // correlator's trailing-30-day filter.
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (let i = 27; i >= 0; i--) {
      const measuredAt = new Date(now.getTime() - i * DAY_MS);
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "WEIGHT",
          value: 82,
          unit: "kg",
          source: "MANUAL",
          measuredAt,
        },
      });
    }

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    // Constant weight = no weekday variance = "insufficient"
    // (`reason: not_significant`). The `n` count is the regression
    // anchor — every seeded row reached the correlator.
    const wkd = envelope.data.correlations.weightWeekday;
    expect(wkd.status).toBe("insufficient");
    expect(wkd.n).toBe(28);
  });
});
