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
    expect(body).toContain("type,value,unit,measuredAt,source,notes,glucoseContext");
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
    const { formatMeasurementsForExport, toCSV } = await import(
      "@/lib/export"
    );
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
    const { invalidateServerDefaultTimezone } = await import(
      "@/lib/tz/resolver"
    );
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
});
