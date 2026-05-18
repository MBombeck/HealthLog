/**
 * v1.4.23 Sr-H1 — chunked-paged measurement reads in `GET /api/analytics`.
 *
 * The senior-dev review (W6) flagged the analytics route as fanning
 * out 17+ unbounded `findMany` queries per request, each pulling the
 * user's entire history for a single MeasurementType. The fix routes
 * every per-type read through `fetchMeasurementSeriesChunked()` —
 * page size 5 000, cursor on `(measuredAt asc, id asc)` — so the
 * working set stays bounded even for a multi-year HealthKit tenant.
 *
 * This test pins two contracts:
 *
 *   1. **Response shape unchanged.** A 6 000-row PULSE dataset spans
 *      two chunks; the resulting `summaries.PULSE` must still report
 *      the correct count and latest value. The chunked helper must
 *      not duplicate or skip rows on the page boundary.
 *
 *   2. **Wide-event annotation present.** The route adds an
 *      `analytics.bp_aggregate.row_count` meta key carrying the total
 *      number of rows read across every chunked per-type query, so ops
 *      can attribute slow requests to outlier users without re-running
 *      a DB query.
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

// Read wide-events back out of the in-memory ring buffer the
// `emitEvent` transport already populates — avoids coupling to the
// Loki/stdout plumbing and works regardless of `LOG_SAMPLE_RATE`.
import { clearLogBuffer, readLogBuffer } from "@/lib/logging/in-memory-buffer";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  clearLogBuffer();
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
      }
    >;
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

describe("GET /api/analytics — chunked per-type reads (Sr-H1)", () => {
  it("returns the correct summary across a 6 000-row dataset spanning two chunks", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("analytics-paged-user");

    // 6 000 PULSE rows — one above MEASUREMENT_CHUNK_SIZE (5 000) so
    // the chunked helper has to advance its cursor at least once. Each
    // row carries a unique `measuredAt` so the cursor's stable
    // `(measuredAt, id)` order produces a deterministic chronological
    // sequence that `summarize()` consumes the same way it would have
    // consumed a single-shot read.
    //
    // v1.4.39 W-SINCE — the route caps the live-fallback per-type read
    // at the trailing 425 days. The seed packs 6 000 rows × 15 min ≈
    // 62.5 days backwards from a fixed anchor; QA F-M-04 (v1.4.39):
    // re-anchor the youngest row to `nowMs - 30 * 86_400_000` so the
    // seed lives ~30-92 days ago regardless of when the test runs.
    // Pre-fix the seed used `nowMs` directly so 28 days from now the
    // 90-day cap would expire it — now 425-day, but the same anchor
    // makes the test stable across long-running CI gaps.
    const ROW_COUNT = 6000;
    const STEP_MS = 15 * 60 * 1000;
    const nowMs = Date.now();
    const youngestRowAtMs = nowMs - 30 * 86_400_000;
    const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      userId: user.id,
      type: "PULSE" as const,
      value: 60 + (i % 40), // deterministic 60..99
      unit: "bpm",
      source: "MANUAL" as const,
      // i = ROW_COUNT - 1 is the freshest row (30 days before `now`);
      // i = 0 is the oldest. The chunked helper reads
      // `(measuredAt asc, id asc)` so the latest value is the last
      // entry in the sorted stream — which the test asserts below.
      measuredAt: new Date(
        youngestRowAtMs - (ROW_COUNT - 1 - i) * STEP_MS,
      ),
    }));
    // createMany batches efficiently; default Postgres parameter limit
    // accommodates this volume in a single statement.
    await prisma.measurement.createMany({ data: rows });

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics"));
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as AnalyticsEnvelope;

    // Response shape unchanged: count matches every row inserted, the
    // latest value is the final row's value (the last index, i = 5999,
    // gives 60 + (5999 % 40) = 60 + 39 = 99). If the cursor skipped or
    // duplicated a row across the chunk boundary either of these
    // assertions fails loudly.
    expect(envelope.data.summaries.PULSE.count).toBe(ROW_COUNT);
    expect(envelope.data.summaries.PULSE.latest).toBe(99);

    // Wide-event annotation surfaces the row count for slow-query
    // attribution. Total reads = 6 000 PULSE rows; every other type
    // is empty (count 0) for this user. The field shape mirrors the
    // existing `analytics.bp_in_target.row_count` slot.
    const buffered = readLogBuffer({ limit: 50 });
    const httpEvent = buffered.find((e) => e.http?.path === "/api/analytics");
    expect(httpEvent).toBeDefined();
    expect(httpEvent!.meta).toBeDefined();
    const analytics = httpEvent!.meta!.analytics as
      | { bp_aggregate?: { row_count?: number } }
      | undefined;
    expect(analytics?.bp_aggregate?.row_count).toBe(ROW_COUNT);
  });
});
