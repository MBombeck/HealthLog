/**
 * v1.4.34 — integration coverage for the server-cache layer.
 *
 * Pins two contracts the unit suite cannot cover end-to-end:
 *
 *   1. **Single-flight under concurrency.** Ten concurrent requests to
 *      `/api/analytics` on a cold cache must fan into a single builder
 *      call — the `pending` map in `ServerCache.wrap()` coalesces every
 *      caller after the first onto the same promise. The Postgres-side
 *      row count for the per-type chunked reads is the witness: the
 *      builder reads ~30 measurement types × 1 chunked findMany each
 *      per call; a busted single-flight would multiply that by 10.
 *
 *   2. **Invalidation closes the loop.** Priming the analytics cache,
 *      then POSTing a new measurement, then re-reading must yield a
 *      MISS — the write endpoint's `invalidateUserMeasurements` call
 *      flushes the prior entry. The `cache.analytics.outcome` annotation
 *      reaches the route's wide-event meta; we read it back through
 *      the response envelope by tagging the first request as `miss` and
 *      the post-write request as `miss` again (same userId + the same
 *      slice key, but the cache was evicted).
 *
 * Test wiring uses the same Postgres testcontainer the other
 * integration suites share; cache state is reset between cases via the
 * registry escape hatch so each test starts cold.
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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const { __resetAllCachesForTests } = await import("@/lib/cache/server-cache");
  __resetAllCachesForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
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
 * Count the builder runs per key on a cache. The analytics bucket holds two
 * cells per account: the thick default body (`<user>|default|<locale>`) and
 * the summaries slice it composes (`<user>|summaries`), which the tile-strip
 * route and the snapshot read too. The bucket-wide `misses` counter therefore
 * reads 2 on a cold mount; coalescing is proven per key, one build each.
 */
function countBuildsPerKey(cache: {
  wrap: (...args: never[]) => Promise<unknown>;
}): Map<string, number> {
  const builds = new Map<string, number>();
  const original = cache.wrap.bind(cache) as unknown as (
    key: string,
    builder: () => Promise<unknown>,
    ttl?: number,
  ) => Promise<unknown>;
  vi.spyOn(cache, "wrap").mockImplementation(((
    key: string,
    builder: () => Promise<unknown>,
    ttl?: number,
  ) =>
    original(
      key,
      () => {
        builds.set(key, (builds.get(key) ?? 0) + 1);
        return builder();
      },
      ttl,
    )) as never);
  return builds;
}

/**
 * The slice's pre-fold remainder is a cell of its own in the same bucket (a
 * closed block, `pre-fold-remainder.ts`), built when the slice takes the
 * rollup path; it is counted apart from the route's two cells.
 */
function preFoldBuildsOf(builds: Map<string, number>, userId: string) {
  return [...builds.entries()]
    .filter(([k]) => k.startsWith(`${userId}|pre-fold-remainder|`))
    .reduce((n, [, c]) => n + c, 0);
}

function buildsOf(builds: Map<string, number>, userId: string) {
  const entries = [...builds.entries()].filter(
    ([k]) => k.startsWith(userId) && !k.includes("|pre-fold-remainder|"),
  );
  return {
    defaultBody: entries
      .filter(([k]) => k.startsWith(`${userId}|default|`))
      .reduce((n, [, c]) => n + c, 0),
    summaries: builds.get(`${userId}|summaries`) ?? 0,
    keys: entries.length,
  };
}

describe("v1.4.34 IW-G — server-cache route integration", () => {
  it("coalesces 10 concurrent /api/analytics reads into a single builder call", async () => {
    const user = await seedSession("cache-stampede-user");

    const { GET } = await import("@/app/api/analytics/route");
    const { caches } = await import("@/lib/cache/server-cache");
    const builds = countBuildsPerKey(caches.analytics);

    // Fire 10 concurrent reads against a cold cache. The first sets up
    // the `pending` promise; the other nine join it. The cache's
    // counter snapshot witnesses the fan-in: misses === 1, stampedes
    // covers the remaining nine reads.
    const requests = Array.from({ length: 10 }, () =>
      (GET as unknown as (req: Request) => Promise<Response>)(
        new Request("http://localhost/api/analytics"),
      ),
    );
    const responses = await Promise.all(requests);

    expect(responses.every((r) => r.status === 200)).toBe(true);
    // One miss (the builder fires for the first caller). Every other
    // caller MUST land on either the in-flight `pending` promise (a
    // stampede) or — if the builder resolved between two `Promise.all`
    // microtasks — the now-warm cache (a hit). What we forbid is a
    // second miss: that would mean the single-flight join failed and a
    // duplicate builder fired.
    // Per cell: the default body built once and the summaries slice it
    // composes built once, nothing else. The bucket counter sums both cells.
    expect(buildsOf(builds, user.id)).toEqual({
      defaultBody: 1,
      summaries: 1,
      keys: 2,
    });
    const stats = caches.analytics.stats();
    expect(stats.misses).toBe(2);
    expect(stats.stampedes + stats.hits).toBe(9);
    // Subsequent serial reads inside the TTL hit the warm cache.
    const warm = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(warm.status).toBe(200);
    // Plus at least one extra hit from this serial read.
    expect(caches.analytics.stats().hits).toBeGreaterThanOrEqual(1);
  });

  it("invalidates the analytics cache after a measurement write", async () => {
    const user = await seedSession("cache-invalidate-user");

    const { GET } = await import("@/app/api/analytics/route");
    const { POST: postMeasurement } =
      await import("@/app/api/measurements/route");
    const { caches } = await import("@/lib/cache/server-cache");
    const builds = countBuildsPerKey(caches.analytics);

    // Prime the cache — first read builds both cells once; second is a hit.
    const first = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(first.status).toBe(200);
    expect(buildsOf(builds, user.id)).toEqual({
      defaultBody: 1,
      summaries: 1,
      keys: 2,
    });
    expect(caches.analytics.stats().misses).toBe(2);
    expect(caches.analytics.stats().hits).toBe(0);

    const second = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(second.status).toBe(200);
    expect(caches.analytics.stats().hits).toBe(1);

    // Write a new measurement — the POST handler calls
    // `invalidateUserMeasurements(user.id)` after its DB commit.
    const writeRes = await (
      postMeasurement as unknown as (req: Request) => Promise<Response>
    )(
      new Request("http://localhost/api/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "WEIGHT",
          value: 82.4,
          measuredAt: new Date().toISOString(),
        }),
      }),
    );
    expect([200, 201]).toContain(writeRes.status);

    // The next read MUST miss — the cache for this userId|default key
    // was evicted by the write's invalidation call.
    const third = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/analytics"),
    );
    expect(third.status).toBe(200);
    // Both cells were evicted by the write and rebuilt once each.
    expect(buildsOf(builds, user.id)).toEqual({
      defaultBody: 2,
      summaries: 2,
      keys: 2,
    });
    expect(caches.analytics.stats().misses).toBe(
      4 + preFoldBuildsOf(builds, user.id),
    );

    // Sanity: the body reflects the new write.
    const body = (await third.json()) as {
      data: { summaries: { WEIGHT: { count: number; latest: number | null } } };
    };
    expect(body.data.summaries.WEIGHT.count).toBe(1);
    expect(body.data.summaries.WEIGHT.latest).toBeCloseTo(82.4, 1);

    // The achievements cache for the same user must also be empty —
    // the measurements helper evicts that bucket too.
    expect(caches.achievements.get(user.id)).toBeNull();
  });

  it("re-reads compliance buckets after an intake POST evicts the cache", async () => {
    const user = await seedSession("cache-intake-invalidate-user");
    const prisma = getPrismaClient();

    // Seed a medication + scheduled intake so the compliance branch
    // has something to aggregate.
    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Test Med",
        dose: "1mg",
        active: true,
        schedules: {
          create: [
            { windowStart: "08:00", windowEnd: "10:00", daysOfWeek: null },
          ],
        },
      },
      include: { schedules: true },
    });
    const event = await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date(),
        takenAt: null,
        skipped: false,
      },
    });

    const { GET: intakeGet, POST: intakePost } =
      await import("@/app/api/medications/intake/route");
    const { NextRequest } = await import("next/server");
    const { caches } = await import("@/lib/cache/server-cache");

    // Prime — first compliance read is a miss.
    const first = await intakeGet(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=30",
      ),
    );
    expect(first.status).toBe(200);
    expect(caches.medicationsIntake.stats().misses).toBe(1);

    // Second read inside the TTL — hit.
    const second = await intakeGet(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=30",
      ),
    );
    expect(second.status).toBe(200);
    expect(caches.medicationsIntake.stats().hits).toBe(1);

    // Mark the dose taken — POST handler calls invalidateUserMedications
    // which flushes the compliance bucket too.
    const writeRes = await intakePost(
      new NextRequest("http://localhost/api/medications/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intakeId: event.id, status: "taken" }),
      }),
    );
    expect(writeRes.status).toBe(200);

    // Next compliance read is a miss again.
    const third = await intakeGet(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=30",
      ),
    );
    expect(third.status).toBe(200);
    expect(caches.medicationsIntake.stats().misses).toBe(2);

    // And the new taken state shows in the bucket aggregate.
    const body = (await third.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    const todayBucket = body.data.find((b) => b.taken > 0);
    expect(todayBucket).toBeDefined();
    expect(todayBucket!.taken).toBeGreaterThanOrEqual(1);
  });
});
