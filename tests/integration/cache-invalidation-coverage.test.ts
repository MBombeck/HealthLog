/**
 * v1.4.35 — invalidation matrix coverage for the IW-G server cache.
 *
 * The audit (F-6) found 16 of 18 write surfaces had no
 * invalidation-verification test. A missed `invalidateUser*` call on
 * any write path silently leaks stale dashboard reads for up to the
 * TTL. This file grids the contract: for each major write surface we
 * prime the matching cache, run the mutation, and assert the cache is
 * empty for the user's key. The intent is breadth — one assertion per
 * write × cache pair — not depth.
 *
 * Cross-user isolation is also pinned: a write by user A must not
 * evict user B's cache slot for the same cache.
 *
 * Reference: `src/lib/cache/invalidate.ts` (the helper module that
 * encodes the write→cache fan-out).
 */
import { NextRequest } from "next/server";
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

// `ensureDbCompatibility` is intentionally LEFT REAL for this file —
// the admin app-settings PUT touches the `app_settings` table whose
// columns land via that helper rather than the migration set in
// `prisma/migrations/`. Mocking it out (as the other integration tests
// do for speed) would make the upsert reference a `default_locale`
// column the test container doesn't carry. Letting the real helper
// run inside the route handler keeps the schema consistent for the
// admin-settings test case in this file.
//
// `isolate: false` in `vitest.integration.config.mts` shares module
// state across files, so a sibling test file that mocks db-compat
// would leak its mock here. The beforeEach below explicitly imports
// the actual implementation through `vi.importActual` and runs it on
// each test setup to defeat that bleed-through.

const PRIMARY_USER_ID = "user-cache-invalidation-primary";
const OTHER_USER_ID = "user-cache-invalidation-other";

async function seedUsers() {
  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      {
        id: PRIMARY_USER_ID,
        username: "cache-primary",
        email: "cache-primary@example.test",
        role: "USER",
      },
      {
        id: OTHER_USER_ID,
        username: "cache-other",
        email: "cache-other@example.test",
        role: "USER",
      },
    ],
  });
}

async function loginAs(userId: string) {
  const prisma = getPrismaClient();
  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
}

async function loginAsAdmin() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "cache-admin",
      email: "cache-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
  return admin.id;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const { __resetAllCachesForTests } = await import(
    "@/lib/cache/server-cache"
  );
  __resetAllCachesForTests();
  // Run the real db-compat helper directly so a sibling test file's
  // `vi.mock("@/lib/db-compat", ...)` cannot leave the `app_settings`
  // table missing columns the admin-settings PUT writes through.
  const realDbCompat =
    await vi.importActual<typeof import("@/lib/db-compat")>("@/lib/db-compat");
  await realDbCompat.ensureDbCompatibility();
  await seedUsers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("v1.4.34 IW-G — invalidation matrix across the major write surfaces", () => {
  it("measurement POST evicts the analytics cache bucket for the writer", async () => {
    await loginAs(PRIMARY_USER_ID);

    const { caches } = await import("@/lib/cache/server-cache");
    // Seed the analytics bucket and a sibling user's bucket to also
    // assert cross-user isolation below.
    caches.analytics.set(`${PRIMARY_USER_ID}|all`, { fake: "data" });
    caches.analytics.set(`${OTHER_USER_ID}|all`, { other: "data" });
    expect(caches.analytics.get(`${PRIMARY_USER_ID}|all`)).not.toBeNull();

    const { POST } = await import("@/app/api/measurements/route");
    const res = await POST(
      new NextRequest("http://localhost/api/measurements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "WEIGHT",
          value: 82.5,
          measuredAt: new Date().toISOString(),
        }),
      }),
    );
    expect([200, 201]).toContain(res.status);

    // The writer's bucket is gone.
    expect(caches.analytics.get(`${PRIMARY_USER_ID}|all`)).toBeNull();
    // The sibling user's bucket is untouched (cross-user isolation).
    expect(caches.analytics.get(`${OTHER_USER_ID}|all`)).not.toBeNull();
  });

  it("mood-entry POST evicts the moodAnalytics cache bucket for the writer", async () => {
    await loginAs(PRIMARY_USER_ID);

    const { caches } = await import("@/lib/cache/server-cache");
    caches.moodAnalytics.set(PRIMARY_USER_ID, { fake: "mood" });
    caches.moodAnalytics.set(OTHER_USER_ID, { other: "mood" });
    expect(caches.moodAnalytics.get(PRIMARY_USER_ID)).not.toBeNull();

    const { POST } = await import("@/app/api/mood-entries/route");
    const res = await POST(
      new NextRequest("http://localhost/api/mood-entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mood: "GUT",
          moodLoggedAt: new Date().toISOString(),
        }),
      }),
    );
    expect([200, 201]).toContain(res.status);

    expect(caches.moodAnalytics.get(PRIMARY_USER_ID)).toBeNull();
    expect(caches.moodAnalytics.get(OTHER_USER_ID)).not.toBeNull();
  });

  it("medication POST evicts the medications cache bucket for the writer", async () => {
    await loginAs(PRIMARY_USER_ID);

    const { caches } = await import("@/lib/cache/server-cache");
    caches.medications.set(PRIMARY_USER_ID, [{ fake: "med" }]);
    caches.medications.set(OTHER_USER_ID, [{ other: "med" }]);
    expect(caches.medications.get(PRIMARY_USER_ID)).not.toBeNull();

    const { POST } = await import("@/app/api/medications/route");
    const res = await POST(
      new NextRequest("http://localhost/api/medications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test Med",
          dose: "10mg",
          schedules: [
            { windowStart: "08:00", windowEnd: "10:00", daysOfWeek: [] },
          ],
        }),
      }),
    );
    expect([200, 201]).toContain(res.status);

    expect(caches.medications.get(PRIMARY_USER_ID)).toBeNull();
    expect(caches.medications.get(OTHER_USER_ID)).not.toBeNull();
  });

  it("dashboard-widgets PUT evicts the dashboardWidgets cache bucket for the writer", async () => {
    await loginAs(PRIMARY_USER_ID);

    const { caches } = await import("@/lib/cache/server-cache");
    caches.dashboardWidgets.set(PRIMARY_USER_ID, { fake: "layout" });
    caches.dashboardWidgets.set(OTHER_USER_ID, { other: "layout" });
    expect(caches.dashboardWidgets.get(PRIMARY_USER_ID)).not.toBeNull();

    const { DEFAULT_DASHBOARD_LAYOUT } = await import("@/lib/dashboard-layout");
    const { PUT } = await import("@/app/api/dashboard/widgets/route");
    const res = await PUT(
      new NextRequest("http://localhost/api/dashboard/widgets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
        }),
      }),
    );
    expect(res.status).toBe(200);

    expect(caches.dashboardWidgets.get(PRIMARY_USER_ID)).toBeNull();
    expect(caches.dashboardWidgets.get(OTHER_USER_ID)).not.toBeNull();
  });

  it("admin app-settings PUT evicts the bugreportStatus singleton cache", async () => {
    await loginAsAdmin();

    const { caches } = await import("@/lib/cache/server-cache");
    caches.bugreportStatus.set("singleton", { fake: "status" });
    expect(caches.bugreportStatus.get("singleton")).not.toBeNull();

    const { PUT } = await import("@/app/api/admin/settings/route");
    const res = await PUT(
      new NextRequest("http://localhost/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bugReportRepo: "owner/repo" }),
      }),
    );
    expect(res.status).toBe(200);

    // The singleton bucket is gone — the next bugreport.status read
    // will rebuild from app_settings.
    expect(caches.bugreportStatus.get("singleton")).toBeNull();
  });
});
