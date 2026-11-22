/**
 * A first sync from one phone, against a real Postgres, with the memory it
 * holds measured rather than assumed.
 *
 * What this pins. A phone that signed in to a fresh account sent its first
 * Apple Health backfill: batches of 500 entries over several connections and
 * dozens of ECG strips within seconds. Every request parsed its body and
 * prepared its rows straight away and then waited for one of the few
 * database connections, so the heap held all of them at once, and on a 1 GB
 * container the process ran out of heap, ending the app for every account on
 * the instance. The heavy-ingest gate (`src/lib/ingest/admission.ts`) admits
 * a bounded number per caller and process and answers the rest 429 with
 * `Retry-After`, which the native client honours.
 *
 * How it measures. Every reading is the used heap right after a forced full
 * collection, so what is compared is what the requests in flight HOLD, not
 * garbage waiting for the collector (whose amount depends on the runner's
 * heap limit). A sampler collects and reads every 100 ms while the burst
 * runs; the growth over the baseline is the number.
 *
 * The two halves are the point. One says the gated burst stays inside a
 * budget, never runs more than the caller's slots at once, and lands every
 * row; the other runs the same burst with the gate opened wide and shows it
 * does not fit that budget. Without the second, the budget could be any
 * number and the first would pass anyway.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetIngestAdmissionForTests,
  __setIngestSlotsForTests,
  INGEST_SLOTS_PER_CALLER,
  ingestAdmissionState,
} from "@/lib/ingest/admission";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-ingest-burst";
const BATCHES = 48;
const ECGS = 24;
const ENTRIES = 500;
const SAMPLES = 15_360;

/**
 * What the gated burst may hold above the baseline. One phone's two slots
 * hold two batches and their rows, a few in line hold their bodies, and the
 * driver's own response bodies sit beside them.
 */
const BUDGET_BYTES = 48 * 1024 * 1024;

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

const gc: () => void = (() => {
  v8.setFlagsFromString("--expose-gc");
  const fn = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return fn;
})();

function liveBytes(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

let sessionId = "";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  __resetIngestAdmissionForTests();
  await getPrismaClient().user.create({
    data: { id: USER_ID, username: "ingest-burst", timezone: "Europe/Berlin" },
  });
  sessionId = (
    await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
  ).id;
  cookieJar.set("healthlog_session", sessionId);
});

afterEach(() => {
  __resetIngestAdmissionForTests();
});

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 9, 1);

/** One batch: 500 ten-minute heart-rate buckets and HRV samples, a day each. */
function batchBody(run: string, index: number): string {
  const dayStart = ANCHOR - index * DAY;
  const entries = Array.from({ length: ENTRIES }, (_, i) => {
    const at = new Date(dayStart + i * 172_000).toISOString();
    return i % 2 === 0
      ? {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
          value: 55 + (i % 40),
          unit: "count/min",
          startDate: at,
          endDate: at,
          externalId: `${run}-hr-${index}-${i}`,
        }
      : {
          hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
          value: 30 + (i % 25),
          unit: "ms",
          startDate: at,
          endDate: at,
          externalId: `${run}-hrv-${index}-${i}`,
        };
  });
  return JSON.stringify({ entries, syncTrigger: "backfill" });
}

function ecgBody(run: string, index: number): string {
  return JSON.stringify({
    externalRecordingId: `${run}-ecg-${index}`,
    recordedAt: new Date(ANCHOR - index * 7 * DAY).toISOString(),
    samplingFrequency: 512,
    samples: Array.from(
      { length: SAMPLES },
      (_, i) => Math.round(Math.sin(i / 20) * 400_000) + (i % 97),
    ),
    averageHeartRate: 64,
    classification: "NOT_DETECTED",
    source: "APPLE_HEALTH",
  });
}

interface BurstResult {
  growthBytes: number;
  maxRunning: number;
  statuses: number[];
  refusedWithoutRetryAfter: number;
  failedEntries: number;
}

/**
 * Every request at once, as a phone on a fast link sends them; a 429 waits
 * out its `Retry-After` and sends the same body again, as the client does.
 */
async function burst(run: string): Promise<BurstResult> {
  const { POST: postBatch } =
    await import("@/app/api/measurements/batch/route");
  const { POST: postEcg } = await import("@/app/api/insights/ecg/route");
  // The phone's credential, which is what the gate keys a caller on.
  const headers = {
    "content-type": "application/json",
    cookie: `healthlog_session=${sessionId}`,
  };
  const send = async (
    handler: (req: NextRequest) => Promise<Response>,
    url: string,
    body: () => string,
  ): Promise<number[]> => {
    const seen: number[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      const res = await handler(
        new NextRequest(url, { method: "POST", headers, body: body() }),
      );
      const text = await res.text();
      seen.push(res.status);
      if (res.status === 200 && url.endsWith("/batch")) {
        const data = (JSON.parse(text) as { data: { failed: number } }).data;
        result.failedEntries += data.failed;
      }
      if (res.status !== 429) return seen;
      const wait = Number(res.headers.get("Retry-After"));
      if (!Number.isFinite(wait)) {
        result.refusedWithoutRetryAfter += 1;
        return seen;
      }
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    return seen;
  };
  const result: BurstResult = {
    growthBytes: 0,
    maxRunning: 0,
    statuses: [],
    refusedWithoutRetryAfter: 0,
    failedEntries: 0,
  };

  const baseline = liveBytes();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      result.growthBytes = Math.max(result.growthBytes, liveBytes() - baseline);
      result.maxRunning = Math.max(
        result.maxRunning,
        ingestAdmissionState().running,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  const all = await Promise.all([
    ...Array.from({ length: BATCHES }, (_, i) =>
      send(postBatch, "http://localhost/api/measurements/batch", () =>
        batchBody(run, i),
      ),
    ),
    ...Array.from({ length: ECGS }, (_, i) =>
      send(postEcg, "http://localhost/api/insights/ecg", () => ecgBody(run, i)),
    ),
  ]);
  sampling = false;
  await sampler;
  result.statuses = all.map((seen) => seen.at(-1) ?? 0);
  return result;
}

describe("a first-sync burst from one phone (real Postgres)", () => {
  it("stays inside its memory budget behind the gate and lands every row", async () => {
    const result = await burst("gated");

    expect(result.statuses.every((s) => s === 200 || s === 201)).toBe(true);
    expect(result.refusedWithoutRetryAfter).toBe(0);
    expect(result.maxRunning).toBeLessThanOrEqual(INGEST_SLOTS_PER_CALLER);
    expect(result.growthBytes).toBeLessThan(BUDGET_BYTES);
    process.stderr.write(
      `gated burst: ${(result.growthBytes / 1048576).toFixed(1)} MB held at most, ${result.maxRunning} running at most\n`,
    );

    expect(result.failedEntries).toBe(0);
    const prisma = getPrismaClient();
    expect(
      await prisma.measurement.count({ where: { userId: USER_ID } }),
    ).toBeGreaterThan(0);
    expect(
      await prisma.ecgRecording.count({ where: { userId: USER_ID } }),
    ).toBe(ECGS);
  }, 240_000);

  it("does not fit that budget with the gate opened wide", async () => {
    __setIngestSlotsForTests(10_000, 10_000);
    const result = await burst("ungated");

    process.stderr.write(
      `ungated burst: ${(result.growthBytes / 1048576).toFixed(1)} MB held at most, ${result.maxRunning} running at most, ${result.statuses.filter((s) => s >= 500).length} answered 5xx\n`,
    );
    expect(result.maxRunning).toBeGreaterThan(INGEST_SLOTS_PER_CALLER);
    expect(result.growthBytes).toBeGreaterThan(BUDGET_BYTES);
  }, 240_000);
});
