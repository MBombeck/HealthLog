/**
 * Unit tests for the shared 02:xx status-cron discovery.
 *
 * Pins the three gates the discovery applies:
 *   1. the operator assistant kill-switch (`insightStatus` flag),
 *   2. the per-user AI-analysis opt-out (the `insights` module switched off
 *      drops the account from the candidate query; `disableCoach` plays no
 *      part any more),
 *   3. the pregenerate-candidate skip (a stale or missing comprehensive
 *      cache → the 04:30 pass owns the user; the 02:xx crons keep the
 *      fresh-cache accounts), applied only while `briefing` is on,
 * plus the nightly status batch's declaration in the worker registry (the
 * dead-queue class guard).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const getAssistantFlags = vi.fn();
vi.mock("@/lib/feature-flags", async () =>
  (
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(() => getAssistantFlags()),
);

import { findStatusCronCandidates } from "../status-cron-candidates";
import { PREGENERATE_STALE_MS } from "../insight-pregenerate";
import { handleGeneralStatusGenerate } from "../reminder/insights-handlers";
import { nightlyInsightPassOptions } from "../reminder/registrar-shared";
import { allJobDefinitions } from "../registry";
import {
  groupNamed,
  groupOf,
  jobOf,
  loadedHandler,
} from "../registry/__tests__/registry-helpers";

const NOW = new Date("2026-06-10T02:00:00.000Z");
const STALE_AT = new Date(NOW.getTime() - PREGENERATE_STALE_MS - 60_000);
const FRESH_AT = new Date(NOW.getTime() - 60_000);

interface FakeUserRow {
  id: string;
  locale: string | null;
  insightsCachedAt: Date | null;
}

function userRow(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: "u1",
    locale: "de",
    insightsCachedAt: null,
    ...overrides,
  };
}

function makePrisma(users: FakeUserRow[], optedOut: string[] = []) {
  const findMany = vi.fn().mockResolvedValue(users);
  const queryRaw = vi.fn().mockResolvedValue(optedOut.map((id) => ({ id })));
  const findUnique = vi.fn();
  return {
    prisma: {
      user: { findMany },
      appSettings: { findUnique },
      $queryRaw: queryRaw,
    },
    findMany,
    findUnique,
    queryRaw,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantFlags.mockResolvedValue({
    enabled: true,
    coach: true,
    briefing: true,
    insightStatus: true,
  });
});

describe("findStatusCronCandidates — gates", () => {
  it("returns nothing when the insightStatus surface is disabled (operator kill-switch)", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
    });
    const { prisma, findMany, queryRaw } = makePrisma([userRow()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("does not filter on disableCoach: hiding the Coach is not an AI opt-out", async () => {
    const { prisma, findMany } = makePrisma([userRow()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findStatusCronCandidates(prisma as any, NOW);
    // Only the accounts pending deletion are left out.
    expect(findMany.mock.calls[0][0].where).toEqual({
      deletionRequestedAt: null,
    });
    expect(JSON.stringify(findMany.mock.calls[0][0])).not.toContain(
      "disableCoach",
    );
  });

  it("drops the accounts that switched the insights module off", async () => {
    const { prisma, findMany, queryRaw } = makePrisma(
      [userRow({ id: "kept", insightsCachedAt: FRESH_AT })],
      ["opted-out-a", "opted-out-b"],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // The module key rides as a bound parameter, never spliced.
    expect(queryRaw.mock.calls[0].slice(1)).toContain("insights");
    expect(findMany.mock.calls[0][0].where).toEqual({
      deletionRequestedAt: null,
      id: { notIn: ["opted-out-a", "opted-out-b"] },
    });
    expect(result).toEqual([{ id: "kept", locale: "de" }]);
  });

  it("skips a pregenerate candidate (stale cache)", async () => {
    const { prisma } = makePrisma([
      userRow({ id: "stale", insightsCachedAt: STALE_AT }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
  });

  it("skips a never-warmed user (null cache belongs to pregenerate)", async () => {
    const { prisma } = makePrisma([
      userRow({ id: "never", insightsCachedAt: null }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([]);
  });

  it("keeps a user whose comprehensive cache is still fresh", async () => {
    const { prisma } = makePrisma([
      userRow({ id: "fresh", insightsCachedAt: FRESH_AT }),
      userRow({ id: "stale", insightsCachedAt: STALE_AT }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([{ id: "fresh", locale: "de" }]);
  });

  it("reads no provider credentials and no operator admin key", async () => {
    const { prisma, findMany, findUnique } = makePrisma([
      userRow({ id: "fresh", insightsCachedAt: FRESH_AT }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findStatusCronCandidates(prisma as any, NOW);
    expect(findMany.mock.calls[0][0].select).toEqual({
      id: true,
      locale: true,
      insightsCachedAt: true,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("keeps every user when the briefing surface is off (the 04:30 pass no-ops)", async () => {
    getAssistantFlags.mockResolvedValue({
      enabled: true,
      coach: true,
      briefing: false,
      insightStatus: true,
    });
    const { prisma } = makePrisma([
      userRow({ id: "stale", insightsCachedAt: STALE_AT }),
      userRow({ id: "never", insightsCachedAt: null }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findStatusCronCandidates(prisma as any, NOW);
    expect(result).toEqual([
      { id: "stale", locale: "de" },
      { id: "never", locale: "de" },
    ]);
  });
});

describe("the nightly status batch is the one status cron", () => {
  const GENERAL_STATUS_QUEUE = "insights-general-status";
  const RETIRED = [
    "insights-blood-pressure-status",
    "insights-weight-status",
    "insights-pulse-status",
    "insights-bmi-status",
    "insights-mood-status",
    "insights-medication-compliance-status",
  ];

  it("registers and schedules the 02:00 batch with the nightly pass options", async () => {
    expect(groupOf(GENERAL_STATUS_QUEUE).name).toBe("status");
    const job = jobOf(GENERAL_STATUS_QUEUE);
    expect(job.cron).toBe("0 2 * * *");
    expect(job.scheduleOptions).toBe(nightlyInsightPassOptions);
    expect(await loadedHandler(GENERAL_STATUS_QUEUE)).toBe(
      handleGeneralStatusGenerate,
    );
  });

  it("retires the six per-metric crons on an instance that still has them", () => {
    expect([...(groupNamed("status").retired ?? [])].sort()).toEqual(
      [...RETIRED].sort(),
    );
    const live = allJobDefinitions().map((job) => job.queue);
    for (const name of RETIRED) expect(live).not.toContain(name);
  });

  it("drives the batch through the shared discovery", () => {
    const statusSrc = fs.readFileSync(
      path.resolve(__dirname, "../reminder/insights-handlers.ts"),
      "utf8",
    );
    const statusBlock = statusSrc.slice(
      statusSrc.indexOf("async function runStatusBatchCron"),
      statusSrc.indexOf("async function handleInsightPregenerateJob"),
    );
    expect(statusBlock).toMatch(/findStatusCronCandidates\(prisma\)/);
    expect(statusBlock).not.toMatch(/prisma\.user\.findMany/);
  });
});
