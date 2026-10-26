/**
 * `GET /api/sync/changes` — cycle module gate.
 *
 * The delta feed multiplexes five domains over one cursor and used to serve
 * `cycleDays` / `cycles` ungated, so an account with cycle tracking off got
 * period days and per-day symptom rows over the very token that
 * `/api/cycle/*` refuses with a 403.
 *
 * Behavioural, not structural: the assertions read the response body and the
 * Prisma call log, so reverting the gate in the route turns them red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    // The mirror walk's token lookup: no token switched, so no walk.
    apiToken: { findMany: vi.fn(async () => []) },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    cycleDayLog: { findMany: vi.fn() },
    menstrualCycle: { findMany: vi.fn() },
  },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { isModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { decodeCursor } from "@/lib/sync/cursor";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const NOW = new Date("2026-07-01T12:00:00.000Z");

/** One live cycle-day row carrying a symptom — the payload that must not leak. */
const CYCLE_DAY_ROW = {
  id: "cd-1",
  userId: "user-1",
  externalId: "ext-cd-1",
  date: NOW,
  flow: "MEDIUM",
  notes: null,
  notesEncrypted: null,
  syncVersion: 3,
  deletedAt: null,
  updatedAt: NOW,
  createdAt: NOW,
  symptoms: [{ id: "sym-1", symptom: "CRAMPS", severity: 2 }],
};

const CYCLE_ROW = {
  id: "mc-1",
  userId: "user-1",
  startDate: NOW,
  endDate: null,
  cycleLength: 28,
  periodLength: 5,
  predicted: false,
  syncVersion: 2,
  deletedAt: null,
  updatedAt: NOW,
  createdAt: NOW,
};

interface FeedBody {
  data: {
    changes: {
      measurements: { upserts: unknown[]; tombstones: unknown[] };
      cycleDays: { upserts: unknown[]; tombstones: unknown[] };
      cycles: { upserts: unknown[]; tombstones: unknown[] };
    };
    cursor: string | null;
  };
}

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/sync/changes${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now(),
  } as never);
  // Non-cycle domains always return rows so a 403/empty-everything result
  // cannot be mistaken for a passing "cycle omitted" assertion.
  // The `measurementMirror` walk reads measurements too (the readings of
  // tokens whose Apple Health setting changed); it finds none here.
  const measurementRow = {
    id: "m-1",
    externalId: "ext-m-1",
    type: "WEIGHT",
    value: 80,
    unit: "kg",
    measuredAt: NOW,
    source: "MANUAL",
    notes: null,
    notesEncrypted: null,
    syncVersion: 1,
    deletedAt: null,
    updatedAt: NOW,
  };
  vi.mocked(prisma.measurement.findMany).mockImplementation((async (args: {
    where?: { ingestToken?: unknown };
  }) => (args.where?.ingestToken ? [] : [measurementRow])) as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.cycleDayLog.findMany).mockResolvedValue([
    CYCLE_DAY_ROW,
  ] as never);
  vi.mocked(prisma.menstrualCycle.findMany).mockResolvedValue([
    CYCLE_ROW,
  ] as never);
});

describe("GET /api/sync/changes — cycle module gate", () => {
  it("omits cycle rows and never queries them when the module is off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);

    const res = await GET(req());
    // OMIT, not refuse — the other four domains must keep syncing.
    expect(res.status).toBe(200);

    const body = (await res.json()) as FeedBody;
    expect(body.data.changes.cycleDays.upserts).toEqual([]);
    expect(body.data.changes.cycleDays.tombstones).toEqual([]);
    expect(body.data.changes.cycles.upserts).toEqual([]);
    expect(body.data.changes.cycles.tombstones).toEqual([]);

    // The rest of the feed is untouched — proves the empty cycle blocks are
    // the gate, not a wholesale refusal.
    expect(body.data.changes.measurements.upserts).toHaveLength(1);

    // Not read out of Postgres at all.
    expect(prisma.cycleDayLog.findMany).not.toHaveBeenCalled();
    expect(prisma.menstrualCycle.findMany).not.toHaveBeenCalled();

    // No symptom string anywhere in the serialised payload.
    expect(JSON.stringify(body)).not.toContain("CRAMPS");
    expect(JSON.stringify(body)).not.toContain("ext-cd-1");
  });

  it("serves cycle rows when the module is on", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(true);

    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as FeedBody;
    expect(body.data.changes.cycleDays.upserts).toHaveLength(1);
    expect(body.data.changes.cycles.upserts).toHaveLength(1);
    expect(prisma.cycleDayLog.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.menstrualCycle.findMany).toHaveBeenCalledTimes(1);
  });

  it("gates on the cycle module key specifically", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
    await GET(req());
    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "cycle");
  });

  it("leaves the cycle cursor watermarks untouched while the module is off", async () => {
    // A skipped domain must not advance its watermark, so re-enabling
    // resumes from where the client left off rather than skipping the rows
    // that changed while the module was hidden.
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const res = await GET(req());
    const body = (await res.json()) as FeedBody;

    const cursor = decodeCursor(body.data.cursor as string);
    expect(cursor).not.toBeNull();
    expect(cursor!.cycleDays).toBeUndefined();
    expect(cursor!.cycles).toBeUndefined();
    // The domain that did return rows advanced normally.
    expect(cursor!.measurements).toBeDefined();
  });
});
