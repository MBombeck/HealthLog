/**
 * v1.4.23 — sleep-stage aggregation in `GET /api/analytics`.
 *
 * The Apple Health batch endpoint stores one Measurement row per sleep
 * stage per night. Two contracts the analytics route now upholds:
 *
 *   1. `summaries.SLEEP_DURATION` aggregates per Berlin day (sums the
 *      stage rows) so the summary's `latest`/`mean` reflect the total
 *      minutes asleep on a given night, not a single stage.
 *
 *   2. A new `sleepStages` block surfaces the per-stage breakdown over
 *      the trailing 30 days when stage-tagged rows exist; it is
 *      `null` for a user with no per-stage rows so the existing UI
 *      keeps painting the totals-only path.
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
    summaries: Record<
      string,
      {
        count: number;
        latest: number | null;
        mean: number | null;
      }
    >;
    sleepStages: {
      windowDays: number;
      nights: number;
      totalMinutes: number;
      stages: Record<string, number>;
    } | null;
  };
}

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

describe("GET /api/analytics — sleep-stage aggregation", () => {
  it("aggregates per-stage rows into a single per-night summary + a stage breakdown", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-stage-user");

    // One night with the four iOS-16+ stages tagged. The analytics
    // route should surface a single Measurement-summary datapoint
    // (~480 minutes total) plus a per-stage breakdown.
    const baseDate = new Date("2026-05-09T01:00:00.000Z");
    const stages: Array<{
      stage: "IN_BED" | "CORE" | "DEEP" | "REM";
      min: number;
    }> = [
      { stage: "IN_BED", min: 480 },
      { stage: "CORE", min: 220 },
      { stage: "DEEP", min: 90 },
      { stage: "REM", min: 90 },
    ];
    let i = 0;
    for (const { stage, min } of stages) {
      await prisma.measurement.create({
        data: {
          userId: user.id,
          type: "SLEEP_DURATION",
          value: min,
          unit: "minutes",
          source: "APPLE_HEALTH",
          measuredAt: new Date(baseDate.getTime() + i * 60 * 1000),
          externalId: `uuid-night-1-${stage}`,
          sleepStage: stage,
        },
      });
      i++;
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

    // Per-stage rows aggregated into a single per-night datapoint:
    //   IN_BED 480 + CORE 220 + DEEP 90 + REM 90 = 880 total minutes.
    // Summary count is 1 (one night), and `latest` matches the sum.
    const summary = envelope.data.summaries.SLEEP_DURATION;
    expect(summary.count).toBe(1);
    expect(summary.latest).toBe(880);

    // Stage breakdown surfaces the per-stage minutes verbatim.
    const sleepStages = envelope.data.sleepStages;
    expect(sleepStages).not.toBeNull();
    expect(sleepStages!.nights).toBe(1);
    expect(sleepStages!.totalMinutes).toBe(880);
    expect(sleepStages!.stages.IN_BED).toBe(480);
    expect(sleepStages!.stages.CORE).toBe(220);
    expect(sleepStages!.stages.DEEP).toBe(90);
    expect(sleepStages!.stages.REM).toBe(90);
  });

  it("returns sleepStages: null when the user has no stage-tagged sleep rows", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("sleep-no-stages");

    // A single sleep row WITHOUT a stage — the legacy/manual path.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "SLEEP_DURATION",
        value: 420,
        unit: "minutes",
        source: "MANUAL",
        measuredAt: new Date("2026-05-09T07:00:00.000Z"),
      },
    });

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

    expect(envelope.data.sleepStages).toBeNull();
    // The non-stage summary path keeps working — one row, value 420.
    expect(envelope.data.summaries.SLEEP_DURATION.count).toBe(1);
    expect(envelope.data.summaries.SLEEP_DURATION.latest).toBe(420);
  });
});
