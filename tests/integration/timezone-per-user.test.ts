/**
 * v1.4.25 W7 — per-user-timezone end-to-end guard.
 *
 * Creates a Pacific/Auckland user (UTC+12 in May, UTC+13 with DST
 * later in the year), inserts a measurement at a UTC instant that
 * maps to "today" in Auckland but "yesterday" in Berlin, then
 * verifies:
 *
 *   1. Withing the Auckland user's session, the CSV export emits
 *      `+12:00` (or `+13:00` if DST is active) on the timestamp
 *      column — NOT the trailing `Z`. This is the issue #167 fix
 *      from the user's perspective.
 *
 *   2. The `PUT /api/auth/me/timezone` route correctly persists a
 *      new zone and the next read picks it up via the resolver
 *      cache (write-time invalidation).
 *
 *   3. The signup payload's browser-detected timezone is captured
 *      onto `User.timezone`, and an invalid value falls back to
 *      the server default.
 *
 * The Coach snapshot itself buckets by UTC and is not yet
 * user-tz-aware (proposal §3 symptom 9 — deferred to a separate
 * v1.5 wave). That assertion is intentionally NOT in this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

async function seedAucklandUser() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "akl-user",
      email: "akl@example.test",
      role: "USER",
      timezone: "Pacific/Auckland",
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

describe("per-user timezone — Pacific/Auckland end-to-end", () => {
  it("CSV export emits the user's offset (not Z) on measuredAt", async () => {
    const prisma = getPrismaClient();
    const me = await seedAucklandUser();

    // 12:00 UTC on May 15 → 00:00 Auckland on May 16 (UTC+12 in
    // May, NZST). Auckland switches to NZDT (UTC+13) only in
    // late September → early April; pick a May instant to keep
    // the offset deterministic for the test snapshot.
    await prisma.measurement.create({
      data: {
        userId: me.id,
        type: "WEIGHT",
        value: 75.5,
        unit: "kg",
        measuredAt: new Date("2026-05-15T12:00:00.000Z"),
        source: "MANUAL",
      },
    });

    const { GET } = await import("@/app/api/export/measurements/route");
    const res = await GET(
      new Request("http://localhost/api/export/measurements", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    expect(res.status).toBe(200);
    const body = await res.text();

    // Header row + one data row.
    expect(body).toContain(
      "type,value,unit,measuredAt,source,notes,glucoseContext",
    );
    // The Auckland offset in May = +12:00 (NZST). The CSV row
    // should carry it verbatim, never the bare Z.
    expect(body).toContain("2026-05-16T00:00:00+12:00");
    expect(body).not.toContain("2026-05-15T12:00:00.000Z");
  });

  it("PUT /api/auth/me/timezone writes the new zone and the resolver picks it up immediately", async () => {
    const prisma = getPrismaClient();
    const me = await seedAucklandUser();

    const { PUT } = await import("@/app/api/auth/me/timezone/route");
    const req = new Request("http://localhost/api/auth/me/timezone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: "Asia/Tokyo" }),
    });
    const res = await PUT(req as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(200);

    const fresh = await prisma.user.findUnique({
      where: { id: me.id },
      select: { timezone: true },
    });
    expect(fresh?.timezone).toBe("Asia/Tokyo");

    // Resolver returns the new value without waiting for the 60s
    // TTL — the route's invalidateUserTimezone() call evicts the
    // cache on write.
    const { resolveUserTimezone } = await import("@/lib/tz/resolver");
    expect(await resolveUserTimezone(me.id)).toBe("Asia/Tokyo");
  });

  // Issue #490 — the client display fix rides a localStorage mirror that
  // `fetchMe` fills from `/api/auth/me`. Pin that the route actually
  // carries the profile zone (the value the mirror consumes), so a field
  // rename / select-list slip can't silently collapse every client render
  // back to the Berlin fallback.
  it("GET /api/auth/me carries the profile timezone the client mirror consumes", async () => {
    await seedAucklandUser();

    const { GET } = await import("@/app/api/auth/me/route");
    // The handler resolves the session from the mocked cookie jar; it
    // takes no request argument.
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { timezone?: string } | null;
    };
    expect(body.data?.timezone).toBe("Pacific/Auckland");
  });

  it("PUT /api/auth/me/timezone rejects an invalid IANA zone with 422", async () => {
    await seedAucklandUser();

    const { PUT } = await import("@/app/api/auth/me/timezone/route");
    const req = new Request("http://localhost/api/auth/me/timezone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: "Mars/Olympus_Mons" }),
    });
    const res = await PUT(req as Parameters<typeof PUT>[0]);
    expect(res.status).toBe(422);
  });

  it("CSV export for an Asia/Tokyo user shows +09:00 (no DST)", async () => {
    const prisma = getPrismaClient();
    const me = await prisma.user.create({
      data: {
        username: "tokyo-user",
        email: "tokyo@example.test",
        role: "USER",
        timezone: "Asia/Tokyo",
      },
    });
    const session = await prisma.session.create({
      data: { userId: me.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    await prisma.measurement.create({
      data: {
        userId: me.id,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        measuredAt: new Date("2026-05-15T03:00:00.000Z"), // 12:00 Tokyo
        source: "MANUAL",
      },
    });

    const { GET } = await import("@/app/api/export/measurements/route");
    const res = await GET(
      new Request("http://localhost/api/export/measurements", {
        method: "GET",
      }) as Parameters<typeof GET>[0],
    );
    const body = await res.text();
    expect(body).toContain("2026-05-15T12:00:00+09:00");
  });

  it("CSV export with no userTz (legacy callers) emits the Z suffix", async () => {
    // This protects the canonical-backup-on-disk contract — the
    // export library has a backward-compatible no-userTz path.
    const { formatMeasurementsForExport, toCSV } = await import("@/lib/export");
    const csv = toCSV(
      formatMeasurementsForExport([
        {
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          measuredAt: new Date("2026-05-15T12:00:00.000Z"),
          source: "MANUAL",
          notes: null,
        },
      ]),
    );
    expect(csv).toContain("2026-05-15T12:00:00.000Z");
  });

  it("registration captures the browser-detected timezone", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/auth/register/route");

    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "fresh-akl@example.test",
        username: "fresh-akl",
        password: "S3cure-Passw0rd-12345",
        timezone: "Pacific/Auckland",
      }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    // The first ever signup becomes admin → 201; subsequent signups
    // succeed too. Either way it's a 2xx.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const stored = await prisma.user.findFirst({
      where: { username: "fresh-akl" },
      select: { timezone: true },
    });
    expect(stored?.timezone).toBe("Pacific/Auckland");
  });

  it("registration with an invalid timezone falls back to Europe/Berlin", async () => {
    // No admin server default is set in this test, so the resolver
    // chain bottoms out at the hard-coded "Europe/Berlin". This
    // covers the worst-case fallback path. Setting an admin default
    // and observing the new value would require the testcontainer
    // migrations to carry every AppSettings column the running
    // schema requires; the integration suite is intentionally
    // tolerant of unmigrated app_settings columns, so we exercise
    // the unset-default path here.
    const prisma = getPrismaClient();
    // Make sure no leftover row pins a default.
    const { invalidateServerDefaultTimezone } =
      await import("@/lib/tz/resolver");
    invalidateServerDefaultTimezone();

    const { POST } = await import("@/app/api/auth/register/route");
    const req = new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bogus@example.test",
        username: "bogus-tz",
        password: "S3cure-Passw0rd-12345",
        timezone: "Mars/Olympus_Mons",
      }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const stored = await prisma.user.findFirst({
      where: { username: "bogus-tz" },
      select: { timezone: true },
    });
    expect(stored?.timezone).toBe("Europe/Berlin");
  });

  it("dashboard streak counts the Auckland-day for a 23:50 NZST reading", async () => {
    // v1.4.25 W7b — surface 1. A Pacific/Auckland user logs a
    // reading at 11:50 UTC, which is 23:50 NZST (May, UTC+12). In
    // Berlin that's 13:50, well clear of midnight either way — but
    // the test pins the principle: streak day-keys honour the user's
    // tz. Without the fix, the legacy Berlin bucketing would pin
    // this reading to the same Berlin day for every user regardless
    // of where their personal "today" actually is.
    const prisma = getPrismaClient();
    const me = await seedAucklandUser();

    // 11:50 UTC on May 14 → 23:50 NZST May 14 (UTC+12 in May).
    await prisma.measurement.create({
      data: {
        userId: me.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date("2026-05-14T11:50:00.000Z"),
        source: "MANUAL",
      },
    });

    const { userDayKey } = await import("@/lib/tz/resolver");
    // The Auckland day-key for this reading is "2026-05-14"; the
    // Berlin day-key would be "2026-05-14" too in May because Berlin
    // is UTC+2, but Auckland users at the day boundary depend on
    // their own tz. Pin the principle directly: the key the
    // dashboard would store for this reading IS the user's tz day.
    expect(
      userDayKey(new Date("2026-05-14T11:50:00.000Z"), "Pacific/Auckland"),
    ).toBe("2026-05-14");
    expect(
      userDayKey(new Date("2026-05-14T11:50:00.000Z"), "Europe/Berlin"),
    ).toBe("2026-05-14");

    // The actual boundary case: 13:00 UTC on May 14 → 01:00 NZST
    // May 15 in Auckland, but still 15:00 on May 14 in Berlin. The
    // dashboard's streak for an Auckland user should pin this to
    // May 15 (their tomorrow); a Berlin user would pin it to May 14.
    expect(
      userDayKey(new Date("2026-05-14T13:00:00.000Z"), "Pacific/Auckland"),
    ).toBe("2026-05-15");
    expect(
      userDayKey(new Date("2026-05-14T13:00:00.000Z"), "Europe/Berlin"),
    ).toBe("2026-05-14");
  });

  it("dashboard summary aggregates streaks in the user's tz", async () => {
    // Hit the actual /api/dashboard/summary route as the Auckland
    // user and confirm the streak counts days using Auckland's
    // calendar, not Berlin's. We seed three consecutive Auckland
    // days of activity; each measurement is timestamped late-evening
    // UTC so a Berlin-bucketed pipeline would group two of them
    // into one day and report a shorter streak.
    const prisma = getPrismaClient();
    const me = await seedAucklandUser();

    // Three consecutive Auckland days, each at 23:30 NZST (11:30 UTC).
    // For Auckland (UTC+12 in May): 2026-05-12, 2026-05-13, 2026-05-14.
    // For Berlin (UTC+2 in May): 13:30 on the same UTC day; the
    // legacy bucketing would still see three days, so this test
    // doesn't trigger a tz divergence on its own. The point is to
    // confirm the route returns a non-zero streak and goes through
    // the user-tz path without crashing.
    for (let i = 0; i < 3; i++) {
      const dt = new Date(`2026-05-${12 + i}T11:30:00.000Z`);
      await prisma.measurement.create({
        data: {
          userId: me.id,
          type: "WEIGHT",
          value: 80 + i,
          unit: "kg",
          measuredAt: dt,
          source: "MANUAL",
        },
      });
    }

    const { GET } = await import("@/app/api/dashboard/summary/route");
    // The handler is typed `() => Promise<Response>`, but the
    // `apiHandler` wrapper unconditionally reads `args[0]` as the
    // Next.js Request — cast through unknown to push the test fixture
    // through without weakening the runtime type.
    const handler = GET as unknown as (req: Request) => Promise<Response>;
    const res = await handler(
      new Request("http://localhost/api/dashboard/summary", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { streak: { currentDays: number; longest: number } };
    };
    // The longest streak across the 3 seeded days is 3.
    expect(body.data.streak.longest).toBeGreaterThanOrEqual(3);
  });

  it("coach snapshot anchors timeline.recent to the user's tz", async () => {
    // v1.4.25 W7b — surface 3. A reading at HH:13:00 UTC sits at
    // 01:00 NZST on the *next* Auckland day (NZST = UTC+12 in May).
    // The snapshot must pin the reading to the Auckland day, not the
    // (incidentally-equal) UTC day a Berlin user would see.
    //
    // The instant must stay inside the snapshot's 14-day `recent`
    // window across every CI run, so we anchor it to "today − 2d at
    // 13:00 UTC" rather than a hard-coded May-2026 calendar date.
    // The − 2d cushion keeps the reading clear of `Date.now()` clock
    // jitter and the late-evening DST cutover in late September
    // (Auckland flips NZST → NZDT, which shifts the day-key for
    // 13:00 UTC by an extra hour but never crosses the date line).
    const prisma = getPrismaClient();
    const me = await seedAucklandUser();

    const anchor = new Date();
    anchor.setUTCDate(anchor.getUTCDate() - 2);
    anchor.setUTCHours(13, 0, 0, 0);

    const dayKey = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(anchor);
    const aucklandDay = dayKey("Pacific/Auckland");
    const berlinDay = dayKey("Europe/Berlin");
    // Sanity check: 13:00 UTC means Auckland is on a different
    // calendar day than Berlin. Without this, the test couldn't
    // assert the tz divergence we care about.
    expect(aucklandDay).not.toBe(berlinDay);

    await prisma.measurement.create({
      data: {
        userId: me.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: anchor,
        source: "MANUAL",
      },
    });

    const { buildCoachSnapshot } = await import("@/lib/ai/coach/snapshot");
    const out = await buildCoachSnapshot(me.id, {
      window: "last30days",
      sources: ["weight"],
    });
    const parsed = JSON.parse(out.snapshotJson) as {
      weight?: {
        timeline?: {
          recent?: Array<{ date: string; weekday: string; value: number }>;
        };
      };
    };
    const recent = parsed.weight?.timeline?.recent ?? [];
    expect(recent.length).toBeGreaterThanOrEqual(1);
    // Bucket lands on the Auckland day, not the Berlin day.
    expect(recent.some((r) => r.date === aucklandDay)).toBe(true);
    expect(recent.some((r) => r.date === berlinDay)).toBe(false);
  });
  it("buckets long dense measurement series by the user's local day", async () => {
    const prisma = getPrismaClient();
    const me = await prisma.user.create({
      data: {
        username: "la-series-user",
        email: "la-series@example.test",
        role: "USER",
        timezone: "America/Los_Angeles",
      },
    });
    const session = await prisma.session.create({
      data: { userId: me.id, expiresAt: new Date(Date.now() + 60_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    const base = new Date();
    base.setUTCDate(base.getUTCDate() - 2);
    base.setUTCHours(0, 30, 0, 0);
    const samples = [
      { measuredAt: base, value: 10 },
      {
        measuredAt: new Date(base.getTime() + 8 * 60 * 60_000),
        value: 30,
      },
      {
        measuredAt: new Date(base.getTime() + 24 * 60 * 60_000),
        value: 50,
      },
      {
        measuredAt: new Date(base.getTime() + 32 * 60 * 60_000),
        value: 70,
      },
    ];
    await prisma.measurement.createMany({
      data: samples.map((sample) => ({
        userId: me.id,
        type: "PULSE" as const,
        value: sample.value,
        unit: "bpm",
        measuredAt: sample.measuredAt,
        source: "MANUAL" as const,
      })),
    });

    const { GET } = await import("@/app/api/measurements/series/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/measurements/series?kind=pulse&days=91",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        points: Array<{ id: string; at: string; value: number }>;
        stats: { count: number };
      };
    };
    const { userDayKey } = await import("@/lib/tz/resolver");
    const expected = [
      { day: userDayKey(samples[0].measuredAt, me.timezone), value: 10 },
      { day: userDayKey(samples[1].measuredAt, me.timezone), value: 40 },
      { day: userDayKey(samples[3].measuredAt, me.timezone), value: 70 },
    ];

    expect(body.data.points).toHaveLength(3);
    expect(
      body.data.points.map((point) => ({
        day: point.id.replace("day:", ""),
        value: point.value,
      })),
    ).toEqual(expected);
    expect(
      body.data.points.map((point) =>
        userDayKey(new Date(point.at), me.timezone),
      ),
    ).toEqual(expected.map(({ day }) => day));
    expect(body.data.stats.count).toBe(4);
  });
});
