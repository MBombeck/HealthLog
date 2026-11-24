/**
 * Concurrent field writes to one account's preference blobs keep every field.
 *
 * Every route that takes one or a few fields of a settings document on the
 * account row merges them into what is stored: read the blob, merge, write it
 * back. Without a lock, two writes from two tabs, or a tab and the phone, that
 * overlap both read the same blob, and the second write drops the first one's
 * field. The routes with an optimistic-concurrency token have the same gap on
 * their tokenless arm, which is the one the native client takes. A row lock
 * (`withUserRowLock`) queues them, so each writer reads after the previous one
 * committed. This file drives each merge route with overlapping writes and
 * checks that every field arrived.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUser(): Promise<{ userId: string; sessionId: string }> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pref-merge-race-user",
      email: "pref-merge-race@example.test",
      role: "USER",
      onboardingCompletedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id, sessionId: session.id };
}

type Handler = (req: Request) => Promise<Response>;

function request(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function storedColumn(
  userId: string,
  column:
    | "thresholdsJson"
    | "activityGoalsJson"
    | "documentsLayoutJson"
    | "notificationPrefs"
    | "modulePreferencesJson"
    | "healthKitConfigJson"
    | "medicationListLayoutJson"
    | "insightsLayoutJson"
    | "coachPrefsJson",
): Promise<Record<string, unknown>> {
  const row = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: userId },
    select: { [column]: true },
  });
  return ((row as Record<string, unknown>)[column] ?? {}) as Record<
    string,
    unknown
  >;
}

describe("concurrent preference field writes from one account", () => {
  it("keeps every target range written in parallel", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/user/thresholds/route");
    const writes: Record<string, { min: number; max: number }> = {
      BLOOD_PRESSURE_SYS: { min: 100, max: 130 },
      BLOOD_PRESSURE_DIA: { min: 60, max: 85 },
      PULSE: { min: 50, max: 90 },
      BODY_FAT: { min: 10, max: 25 },
      SLEEP_DURATION: { min: 7, max: 9 },
      ACTIVITY_STEPS: { min: 6000, max: 15000 },
    };
    const responses = await Promise.all(
      Object.entries(writes).map(([metric, range]) =>
        (PUT as Handler)(
          request("PUT", "/api/user/thresholds", { [metric]: range }),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(
      Object.keys(writes).map(() => 200),
    );
    const stored = await storedColumn(userId, "thresholdsJson");
    for (const [metric, range] of Object.entries(writes)) {
      expect(stored[metric], metric).toEqual(range);
    }
  });

  it("keeps every activity goal written in parallel", async () => {
    const { userId } = await seedUser();
    const { PATCH } = await import("@/app/api/activity/goals/route");
    const writes = {
      workoutsPerWeek: 4,
      activeMinutesPerWeek: 150,
      stepsPerWeek: 70_000,
      stepsPerMonth: 300_000,
    };
    const responses = await Promise.all(
      Object.entries(writes).map(([key, value]) =>
        (PATCH as Handler)(
          request("PATCH", "/api/activity/goals", { [key]: value }),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const stored = await storedColumn(userId, "activityGoalsJson");
    expect(stored).toMatchObject(writes);
  });

  it("keeps both vault layout choices written in parallel", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/documents/inbound/layout/route");
    // Two fields only, so run several rounds: each round flips both.
    for (const [view, arrangement] of [
      ["list", "flow"],
      ["cards", "stacked"],
      ["list", "stacked"],
      ["cards", "flow"],
    ] as const) {
      const responses = await Promise.all([
        (PUT as Handler)(
          request("PUT", "/api/documents/inbound/layout", {
            version: 1,
            view,
          }),
        ),
        (PUT as Handler)(
          request("PUT", "/api/documents/inbound/layout", {
            version: 1,
            arrangement,
          }),
        ),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const stored = await storedColumn(userId, "documentsLayoutJson");
      expect(stored, `${view}/${arrangement}`).toMatchObject({
        view,
        arrangement,
      });
    }
  });

  it("keeps every notification category patched in parallel without a token", async () => {
    const { userId } = await seedUser();
    const { PATCH } =
      await import("@/app/api/auth/me/notification-prefs/route");
    const writes = [
      { medication: { clientManaged: true } },
      { mood: { reminderHour: 21 } },
      { cycle: { clientManaged: true } },
      { coach: { nudgesEnabled: false } },
    ];
    const responses = await Promise.all(
      writes.map((body) =>
        (PATCH as Handler)(
          request("PATCH", "/api/auth/me/notification-prefs", body),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const stored = await storedColumn(userId, "notificationPrefs");
    expect(stored).toMatchObject({
      medication: { clientManaged: true },
      mood: { reminderHour: 21 },
      cycle: { clientManaged: true },
      coach: { nudgesEnabled: false },
    });
  });

  it("keeps every module switched in parallel without a token", async () => {
    const { userId } = await seedUser();
    const { PATCH } = await import("@/app/api/auth/me/modules/route");
    const { WRITABLE_MODULE_KEYS } = await import("@/lib/validations/modules");
    const keys = WRITABLE_MODULE_KEYS.slice(0, 6);
    expect(keys.length).toBe(6);
    const responses = await Promise.all(
      keys.map((key) =>
        (PATCH as Handler)(
          request("PATCH", "/api/auth/me/modules", { [key]: false }),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(keys.map(() => 200));
    const stored = await storedColumn(userId, "modulePreferencesJson");
    for (const key of keys) expect(stored[key], key).toBe(false);
  });

  it("keeps every HealthKit entry patched in parallel", async () => {
    const { userId } = await seedUser();
    const { PATCH } = await import("@/app/api/integrations/healthkit/route");
    const ids = ["bodyMass", "bp", "glucose"];
    const responses = await Promise.all(
      ids.map((id) =>
        (PATCH as Handler)(
          request("PATCH", "/api/integrations/healthkit", {
            entries: [{ id, direction: "readOnly", enabled: false }],
          }),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const stored = (await storedColumn(userId, "healthKitConfigJson")) as {
      entries?: { id: string; direction: string; enabled: boolean }[];
    };
    for (const id of ids) {
      expect(
        stored.entries?.find((entry) => entry.id === id),
        id,
      ).toMatchObject({ direction: "readOnly", enabled: false });
    }
  });

  it("keeps both medication list choices written in parallel without a token", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/medications/layout/route");
    for (const [view, groupBy] of [
      ["table", "category"],
      ["cards", "none"],
      ["table", "none"],
      ["cards", "category"],
    ] as const) {
      const responses = await Promise.all([
        (PUT as Handler)(
          request("PUT", "/api/medications/layout", { version: 1, view }),
        ),
        (PUT as Handler)(
          request("PUT", "/api/medications/layout", { version: 1, groupBy }),
        ),
      ]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const stored = await storedColumn(userId, "medicationListLayoutJson");
      expect(stored, `${view}/${groupBy}`).toMatchObject({ view, groupBy });
    }
  });

  it("keeps every Coach reminder suggestion dismissed in parallel", async () => {
    const { userId } = await seedUser();
    const { POST } = await import("@/app/api/coach/reminder-suggestions/route");
    const { CADENCE_CATALOG } = await import("@/lib/ai/coach/suggest-reminder");
    const cadences = Object.keys(CADENCE_CATALOG).slice(0, 4);
    expect(cadences.length).toBeGreaterThan(1);
    const responses = await Promise.all(
      cadences.map((cadenceId) =>
        (POST as Handler)(
          request("POST", "/api/coach/reminder-suggestions", {
            cadenceId,
            action: "dismiss",
          }),
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(cadences.map(() => 200));
    const stored = (await storedColumn(userId, "coachPrefsJson")) as {
      reminderSuggestions?: { dismissedCadences?: string[] };
    };
    expect(
      [...(stored.reminderSuggestions?.dismissedCadences ?? [])].sort(),
    ).toEqual([...cadences].sort());
  });

  it("keeps every target range a guardian writes in parallel for a profile", async () => {
    const { userId: guardianId, sessionId } = await seedUser();
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardianId,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
      gender: null,
    });
    await switchSessionTo(sessionId, profile.id);
    const { PATCH } = await import("@/app/api/record-settings/[family]/route");
    const writes: Record<string, { min: number; max: number }> = {
      BLOOD_PRESSURE_SYS: { min: 100, max: 130 },
      BLOOD_PRESSURE_DIA: { min: 60, max: 85 },
      PULSE: { min: 50, max: 90 },
      SLEEP_DURATION: { min: 7, max: 9 },
    };
    const responses = await Promise.all(
      Object.entries(writes).map(([metric, range]) =>
        PATCH(
          new NextRequest("http://localhost/api/record-settings/thresholds", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ overrides: { [metric]: range } }),
          }),
          { params: Promise.resolve({ family: "thresholds" }) },
        ),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const stored = await storedColumn(profile.id, "thresholdsJson");
    for (const [metric, range] of Object.entries(writes)) {
      expect(stored[metric], metric).toEqual(range);
    }
  });

  it("keeps the tiles and the sections written in parallel without a token", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/insights/layout/route");
    const responses = await Promise.all([
      (PUT as Handler)(
        request("PUT", "/api/insights/layout", {
          version: 2,
          tiles: [{ id: "overview", visible: false, order: 0 }],
        }),
      ),
      (PUT as Handler)(
        request("PUT", "/api/insights/layout", {
          version: 2,
          sections: [{ id: "vitals", visible: false, order: 0 }],
        }),
      ),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const stored = (await storedColumn(userId, "insightsLayoutJson")) as {
      tiles?: { id: string; visible: boolean }[];
      sections?: { id: string; visible: boolean }[];
    };
    expect(stored.tiles?.find((t) => t.id === "overview")?.visible).toBe(false);
    expect(stored.sections?.find((t) => t.id === "vitals")?.visible).toBe(
      false,
    );
  });
});
