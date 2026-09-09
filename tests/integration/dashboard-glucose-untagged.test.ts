/**
 * #943 — untagged glucose readings light the dashboard tile.
 *
 * A reporter's meter syncs through Apple Health and never writes HealthKit's
 * blood-glucose meal-time metadata, so all of their readings carry a NULL
 * `glucose_context`. The tile strip filtered the four named contexts against
 * the per-context summaries, matched none, and omitted the tile — module on,
 * layout toggle on, a reading from today, and no warning anywhere.
 *
 * A real Postgres is what makes this convincing: the summaries are built from
 * rows the database actually holds, with the column genuinely NULL, and the
 * tile gate is the same pure resolver the page renders through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

import { resolveGlucoseTiles } from "@/components/dashboard/dashboard-gates";
import type { DataSummary } from "@/lib/analytics/trends";

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

interface AnalyticsEnvelope {
  data: {
    glucoseByContext: Record<string, DataSummary> | null;
  };
  error: null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const READINGS = 20;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedUntaggedGlucose() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "glucose-untagged",
      email: "glucose-untagged@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);

  // 20 readings, one per day, newest first at 104 mg/dL. Every one of them
  // arrives exactly as the reporter's sync writes them: no meal-time context.
  const now = Date.now();
  await prisma.measurement.createMany({
    data: Array.from({ length: READINGS }, (_, i) => ({
      userId: user.id,
      type: "BLOOD_GLUCOSE" as const,
      value: 104 + i,
      unit: "mg/dL",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(now - i * DAY_MS),
      glucoseContext: null,
    })),
  });
  return user;
}

async function readAnalytics(): Promise<AnalyticsEnvelope> {
  const { GET } = await import("@/app/api/analytics/route");
  const response = await (
    GET as unknown as (req: Request) => Promise<Response>
  )(new Request("http://localhost/api/analytics"));
  expect(response.status).toBe(200);
  return (await response.json()) as AnalyticsEnvelope;
}

describe("dashboard glucose tile with untagged readings (#943)", () => {
  it("stores the readings with a NULL context", async () => {
    const user = await seedUntaggedGlucose();
    const rows = await getPrismaClient().measurement.findMany({
      where: { userId: user.id, type: "BLOOD_GLUCOSE" },
      select: { glucoseContext: true },
    });

    expect(rows).toHaveLength(READINGS);
    expect(rows.every((row) => row.glucoseContext === null)).toBe(true);
  });

  it("reports the tile as eligible and carries the latest value", async () => {
    await seedUntaggedGlucose();

    const envelope = await readAnalytics();
    const byContext = envelope.data.glucoseByContext;
    expect(byContext).not.toBeNull();

    // The summaries carry the untagged bucket, and nothing else.
    expect(Object.keys(byContext ?? {})).toEqual(["UNSPECIFIED"]);
    const summary = byContext!.UNSPECIFIED;
    expect(summary.count).toBe(READINGS);
    expect(summary.latest).toBe(104);
    expect(summary.avg30).not.toBeNull();

    // …and the tile gate the dashboard renders through says "paint it".
    const tiles = resolveGlucoseTiles(byContext ?? undefined);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({
      bucket: "UNSPECIFIED",
      labelKey: "targets.glucoseUnspecified",
    });
    expect(tiles[0].summary.latest).toBe(104);
  });

  it("keeps a tagged reading in its own bucket beside the untagged ones", async () => {
    const user = await seedUntaggedGlucose();
    await getPrismaClient().measurement.create({
      data: {
        userId: user.id,
        type: "BLOOD_GLUCOSE",
        value: 92,
        unit: "mg/dL",
        source: "MANUAL",
        measuredAt: new Date(),
        glucoseContext: "FASTING",
      },
    });

    const envelope = await readAnalytics();
    const byContext = envelope.data.glucoseByContext ?? {};

    expect(Object.keys(byContext).sort()).toEqual(["FASTING", "UNSPECIFIED"]);
    expect(byContext.FASTING.count).toBe(1);
    expect(byContext.UNSPECIFIED.count).toBe(READINGS);
    expect(resolveGlucoseTiles(byContext).map((tile) => tile.bucket)).toEqual([
      "FASTING",
      "UNSPECIFIED",
    ]);
  });
});
