/**
 * `POST /api/measurements/batch` — which issue belongs to which entry.
 *
 * A whole-batch 422 (`measurement.batch.invalid`) lists every problem in
 * `details.issues`. The native client splits such a batch: it drops the
 * entries the issues name and resends the rest, so one bad reading does not
 * cost the valid ones. That only works if every problem caused by one entry
 * carries a path that starts `entries.<n>`, and if the problems that are not
 * about an entry (the wrapper itself) never do. Both halves are pinned here,
 * and the first case proves the split by resending what is left.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { update: vi.fn() },
    measurement: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        return (fn as (tx: unknown) => unknown)(prisma);
      }
    }),
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: vi.fn(
    async (_tx: unknown, input: Record<string, unknown>) => ({
      status: "inserted",
      row: { id: "row-1", ...input },
    }),
  ),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const AT = new Date(Date.now() - 3_600_000).toISOString();

function entry(i: number, overrides: Record<string, unknown> = {}) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value: 64,
    unit: "count/min",
    startDate: AT,
    endDate: AT,
    externalId: `uuid-${i}`,
    ...overrides,
  };
}

type Issue = { path: string; code: string };

async function issuesFor(body: unknown): Promise<Issue[]> {
  const res = await post(body);
  expect(res.status).toBe(422);
  const json = (await res.json()) as {
    details: { issues: Issue[] };
    meta?: { errorCode?: string };
  };
  expect(json.meta?.errorCode).toBe("measurement.batch.invalid");
  return json.details.issues;
}

/** The entry index an issue names, or null when it names the batch itself. */
function entryIndex(path: string): number | null {
  const m = /^entries\.(\d+)(?:\.|$)/.exec(path);
  return m ? Number(m[1]) : null;
}

/** The paths that are about the batch wrapper and no single entry. */
const BATCH_LEVEL_PATHS = new Set(["", "entries", "syncTrigger"]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
});

describe("POST /api/measurements/batch — every entry problem names its entry", () => {
  it("names each bad entry as entries.<n>, so the rest of the batch can be resent", async () => {
    const entries = [
      entry(0),
      entry(1, { startDate: "yesterday" }),
      entry(2),
      entry(3, { value: "64" }),
      "not an entry",
      entry(5, { hkIdentifier: "", unit: "" }),
      entry(6),
    ];
    const issues = await issuesFor({ entries });

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(entryIndex(issue.path), issue.path).not.toBeNull();
    }
    const bad = new Set(issues.map((i) => entryIndex(i.path)));
    expect([...bad].sort()).toEqual([1, 3, 4, 5]);

    // The split the client performs: drop the named entries, resend the rest.
    const kept = entries.filter((_, i) => !bad.has(i));
    const res = await post({ entries: kept });
    expect(res.status).toBe(200);
  });

  it("names the batch itself, never an entry, when the wrapper is wrong", async () => {
    const cases: unknown[] = [
      [],
      { entries: [] },
      { entries: "x" },
      { entries: [entry(0)], syncTrigger: "sometimes" },
    ];
    let seen = 0;
    for (const body of cases) {
      for (const issue of await issuesFor(body)) {
        expect(BATCH_LEVEL_PATHS.has(issue.path), issue.path).toBe(true);
        expect(entryIndex(issue.path)).toBeNull();
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThanOrEqual(cases.length);
  });
});
