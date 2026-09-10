/**
 * A real response, parsed against the schema that publishes it.
 *
 * Nothing in the gate did this before. `pnpm openapi:check` proves the YAML
 * matches the registry; `openapi-route-coverage-guard` proves the verb is
 * listed. Both pass when the registered schema disagrees with what the handler
 * actually sends, and that gap is how `/api/sync/changes` ended up shipping
 * five domains against a three-domain contract while the body was invalid
 * against its own published schema.
 *
 * Two responses are covered — the two that were broken:
 *
 *   - `GET /api/sync/changes`, the multi-domain delta the native client mirrors
 *     its whole history from.
 *   - a multi-issue 422, whose `details.issues` array is the reason the
 *     envelope exists and was the field the envelope did not declare.
 *
 * The check is stricter than `safeParse` alone. Zod strips undeclared keys
 * rather than refusing them, so a pass would say nothing about a field the
 * server sends and the contract omits — exactly the direction both of those
 * drifted in. Comparing the parsed value back to the raw body catches
 * the strip: if anything was dropped, the schema is short of the wire.
 *
 * One limit worth knowing before leaning on that half: `meta` is declared as a
 * loose object, deliberately, because real refusals put `removedIn`,
 * `replacedBy` and per-integration context there. Loose keys survive the parse,
 * so the strip comparison does not reach inside `meta`. A `meta` field that
 * ever becomes load-bearing for a client needs its own declaration and its own
 * assertion.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { syncChangesResponse } from "@/lib/openapi/routes/sync";
import { errorEnvelope } from "@/lib/openapi/routes/shared";

const TEST_USER_ID = "user-openapi-response-shape";

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
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();

  // FEMALE so the cycle module is on by default and the two domains the
  // contract used to omit actually carry rows.
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "openapi-response-shape",
      email: "openapi-response-shape@example.test",
      gender: "FEMALE",
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

/**
 * Seed one live row and one soft-deleted row per domain, so every `upserts`
 * and every `tombstones` array in the page is non-empty. An all-empty page
 * would parse against almost any schema.
 */
async function seedEveryDomain(): Promise<void> {
  const prisma = getPrismaClient();
  const at = new Date("2026-02-02T08:00:00.000Z");
  const gone = new Date("2026-02-02T09:00:00.000Z");

  await prisma.measurement.createMany({
    data: [
      {
        id: "shape-measurement-live",
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 79.2,
        unit: "kg",
        measuredAt: at,
        source: "MANUAL",
        externalId: "shape-live",
      },
      {
        id: "shape-measurement-gone",
        userId: TEST_USER_ID,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        measuredAt: at,
        source: "MANUAL",
        externalId: "shape-gone",
        deletedAt: gone,
      },
    ],
  });

  await prisma.moodEntry.createMany({
    data: [
      {
        id: "shape-mood-live",
        userId: TEST_USER_ID,
        date: "2026-02-02",
        mood: "GOOD",
        score: 4,
        moodLoggedAt: at,
        source: "MANUAL",
      },
      {
        id: "shape-mood-gone",
        userId: TEST_USER_ID,
        date: "2026-02-01",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: at,
        source: "MANUAL",
        deletedAt: gone,
      },
    ],
  });

  const medication = await prisma.medication.create({
    data: {
      id: "shape-medication",
      userId: TEST_USER_ID,
      name: "Test compound",
      dose: "1 tablet",
    },
  });
  await prisma.medicationIntakeEvent.createMany({
    data: [
      {
        id: "shape-intake-live",
        userId: TEST_USER_ID,
        medicationId: medication.id,
        scheduledFor: at,
        takenAt: at,
        skipped: false,
        source: "WEB",
      },
      {
        id: "shape-intake-gone",
        userId: TEST_USER_ID,
        medicationId: medication.id,
        scheduledFor: gone,
        takenAt: null,
        skipped: true,
        source: "WEB",
        deletedAt: gone,
      },
    ],
  });

  await prisma.menstrualCycle.createMany({
    data: [
      {
        id: "shape-cycle-live",
        userId: TEST_USER_ID,
        startDate: "2026-01-05",
      },
      {
        id: "shape-cycle-gone",
        userId: TEST_USER_ID,
        startDate: "2025-12-05",
        deletedAt: gone,
      },
    ],
  });
  await prisma.cycleDayLog.createMany({
    data: [
      {
        id: "shape-day-live",
        userId: TEST_USER_ID,
        date: "2026-01-05",
        cycleId: "shape-cycle-live",
        flow: "MEDIUM",
        source: "MANUAL",
      },
      {
        id: "shape-day-gone",
        userId: TEST_USER_ID,
        date: "2026-01-04",
        source: "MANUAL",
        deletedAt: gone,
      },
    ],
  });
}

describe("published response schemas against real bodies", () => {
  it("parses a full /api/sync/changes page and drops nothing", async () => {
    await seedEveryDomain();
    const { GET } = await import("@/app/api/sync/changes/route");

    const res = await GET(
      new NextRequest("http://localhost/api/sync/changes") as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };

    const parsed = syncChangesResponse.safeParse(body.data);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);

    // Every domain actually carried rows, so the parse above was asked a real
    // question rather than being handed five empty pairs.
    const changes = (
      body.data as {
        changes: Record<string, { upserts: unknown[]; tombstones: unknown[] }>;
      }
    ).changes;
    for (const domain of [
      "measurements",
      "mood",
      "intakes",
      "cycleDays",
      "cycles",
    ]) {
      expect(changes[domain].upserts.length).toBeGreaterThan(0);
      expect(changes[domain].tombstones.length).toBeGreaterThan(0);
    }

    // Zod strips what it does not declare, so an equal round-trip is the part
    // that proves the contract is not short of the wire.
    expect(parsed.data).toEqual(body.data);
  });

  it("parses the cursorExpired short-circuit page too", async () => {
    const { GET } = await import("@/app/api/sync/changes/route");

    // A cursor whose watermark predates tombstone retention forces the
    // early return, which builds its own literal page rather than the one
    // the domain walks assemble — a second shape under the same schema.
    const { encodeCursor } = await import("@/lib/sync/cursor");
    const stale = encodeCursor({
      measurements: {
        updatedAtMs: Date.now() - 400 * 24 * 60 * 60 * 1000,
        id: "long-gone",
      },
    });

    const res = await GET(
      new NextRequest(
        `http://localhost/api/sync/changes?cursor=${stale}`,
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { cursorExpired: boolean } };

    const parsed = syncChangesResponse.safeParse(body.data);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(body.data);
  });

  it("parses a multi-issue 422 against the published error envelope", async () => {
    const { GET } = await import("@/app/api/measurements/route");

    const res = await GET(
      new NextRequest(
        "http://localhost/api/measurements?limit=0&offset=-3&sortDir=sideways",
      ) as never,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details?: { issues: unknown[] };
    };

    // The envelope exists to report every bad field at once; if only one
    // arrives, the fixture stopped exercising the multi-issue path.
    expect(body.details?.issues.length ?? 0).toBeGreaterThan(1);

    const parsed = errorEnvelope.safeParse(body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data).toEqual(body);
  });
});
