/**
 * `GET/POST /api/admin/maintenance/pulse-day-mean` — the pulse day-mean
 * method's dry run and apply step. Admin only; apply needs a finished dry run
 * from the last seven days, and nothing starts while a run is active.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    appSettings: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  activePulseDayMeanMethod,
  setActivePulseDayMeanMethod,
} from "@/lib/measurements/day-statistic";

const ADMIN = {
  session: { id: "s-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" as const },
};
const USER = {
  session: { id: "s-2", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "bob", role: "USER" as const },
};

const URL = "http://localhost/api/admin/maintenance/pulse-day-mean";
const get = () =>
  (GET as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest(URL),
  );
const post = (body: unknown) =>
  (POST as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const NOW = new Date("2026-10-16T12:00:00Z");
const send = vi.fn();

function settings(
  dryRun: unknown,
  method = "hour_mean_v1",
  appliedAt: Date | null = null,
) {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    pulseDayMeanMethod: method,
    pulseDayMeanAppliedAt: appliedAt,
    pulseDayMeanDryRunJson: dryRun,
  } as never);
}

function activeJobs(n: number) {
  vi.mocked(prisma.$queryRaw).mockResolvedValue([{ n }] as never);
}

const RESULT = {
  accounts: 1,
  daysCompared: 30,
  daysChangedOver1Bpm: 2,
  maxChangeBpm: 3.4,
  distribution: [
    { bucket: "0-1", days: 28 },
    { bucket: "1-2", days: 1 },
    { bucket: "2-5", days: 1 },
    { bucket: "5+", days: 0 },
  ],
  perAccount: [{ account: "#1", days: 30, changedOver1Bpm: 2 }],
};

function doneAt(iso: string) {
  return {
    status: "done",
    startedAt: iso,
    finishedAt: iso,
    result: RESULT,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setActivePulseDayMeanMethod("hour_mean_v1");
  vi.mocked(getSession).mockResolvedValue(ADMIN as never);
  vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
  vi.mocked(prisma.appSettings.upsert).mockResolvedValue({} as never);
  send.mockResolvedValue("job-1");
  activeJobs(0);
});

afterEach(() => {
  vi.useRealTimers();
  setActivePulseDayMeanMethod("hour_mean_v1");
});

describe("admin only", () => {
  it("refuses anyone but an admin, before reading anything", async () => {
    vi.mocked(getSession).mockResolvedValue(USER as never);
    expect((await get()).status).toBe(403);
    expect((await post({ action: "dry_run" })).status).toBe(403);
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("answers the method and the last dry run", async () => {
    settings(doneAt("2026-10-15T08:00:00.000Z"));
    const body = await (await get()).json();
    expect(body.data).toEqual({
      method: "hour_mean_v1",
      appliedAt: null,
      lastDryRun: doneAt("2026-10-15T08:00:00.000Z"),
      lastRebuild: null,
    });
  });

  it("reads a run marked running with no live job behind it as failed", async () => {
    settings({
      status: "running",
      startedAt: "2026-10-16T11:00:00.000Z",
      finishedAt: null,
      result: null,
    });
    activeJobs(0);
    const body = await (await get()).json();
    expect(body.data.lastDryRun.status).toBe("failed");
  });

  it("drops a stored value of the wrong shape instead of passing it on", async () => {
    settings({ status: "done", userId: "u-1" });
    const body = await (await get()).json();
    expect(body.data.lastDryRun).toBeNull();
  });
});

describe("POST dry_run", () => {
  it("marks the dry run queued and enqueues it", async () => {
    settings(null);
    const res = await post({ action: "dry_run" });
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ enqueued: true });
    expect(send).toHaveBeenCalledWith(
      "pulse-day-mean",
      { action: "dry_run" },
      expect.objectContaining({
        retryLimit: 0,
        singletonKey: "pulse-day-mean",
      }),
    );
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          pulseDayMeanDryRunJson: expect.objectContaining({ status: "queued" }),
        },
      }),
    );
  });

  it("answers 409 busy while a run is active, and starts nothing", async () => {
    activeJobs(1);
    const res = await post({ action: "dry_run" });
    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe(
      "maintenance.pulseDayMean.busy",
    );
    expect(send).not.toHaveBeenCalled();
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("puts the last dry run back when the send loses the singleton", async () => {
    const previous = doneAt("2026-10-15T08:00:00.000Z");
    settings(previous);
    send.mockResolvedValue(null);
    const res = await post({ action: "dry_run" });
    expect(res.status).toBe(409);
    expect(vi.mocked(prisma.appSettings.upsert).mock.lastCall?.[0]).toEqual(
      expect.objectContaining({
        update: { pulseDayMeanDryRunJson: { ...previous, rebuild: null } },
      }),
    );
  });
});

describe("POST apply", () => {
  it("is refused without a dry run", async () => {
    settings(null);
    const res = await post({ action: "apply" });
    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe(
      "maintenance.pulseDayMean.dryRunRequired",
    );
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("is refused with a dry run older than seven days", async () => {
    settings(doneAt("2026-10-09T11:59:00.000Z"));
    expect((await post({ action: "apply" })).status).toBe(409);
  });

  it("is refused with a dry run that failed", async () => {
    settings({ ...doneAt("2026-10-15T08:00:00.000Z"), status: "failed" });
    expect((await post({ action: "apply" })).status).toBe(409);
  });

  it("is refused 409 busy while a run is active", async () => {
    settings(doneAt("2026-10-15T08:00:00.000Z"));
    activeJobs(1);
    const res = await post({ action: "apply" });
    expect((await res.json()).meta.errorCode).toBe(
      "maintenance.pulseDayMean.busy",
    );
  });

  it("switches the method, enqueues the rebuild and audits it", async () => {
    settings(doneAt("2026-10-15T08:00:00.000Z"));
    const res = await post({ action: "apply" });
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ enqueued: true });
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          pulseDayMeanMethod: "weighted_hour_mean_v2",
          pulseDayMeanAppliedAt: NOW,
        },
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "pulse-day-mean",
      { action: "rebuild" },
      expect.anything(),
    );
    expect(activePulseDayMeanMethod()).toBe("weighted_hour_mean_v2");
    expect(auditLog).toHaveBeenCalledWith(
      "admin.pulseDayMean.apply",
      expect.objectContaining({
        userId: "admin-1",
        details: { method: "weighted_hour_mean_v2", rebuildEnqueued: true },
      }),
    );
  });
});

describe("POST rebuild", () => {
  const failedRebuild = {
    status: "failed",
    startedAt: "2026-10-15T09:00:00.000Z",
    finishedAt: "2026-10-15T09:05:00.000Z",
    accounts: null,
    rows: null,
  };

  it("is refused before any apply", async () => {
    settings(doneAt("2026-10-15T08:00:00.000Z"));
    const res = await post({ action: "rebuild" });
    expect(res.status).toBe(409);
    expect((await res.json()).meta.errorCode).toBe(
      "maintenance.pulseDayMean.dryRunRequired",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("runs the recalculation again after a stopped one, without a new dry run", async () => {
    // The dry run is three weeks old: apply would refuse it, a rebuild does not.
    settings(
      { ...doneAt("2026-09-20T08:00:00.000Z"), rebuild: failedRebuild },
      "weighted_hour_mean_v2",
      new Date("2026-09-20T09:00:00.000Z"),
    );
    const res = await post({ action: "rebuild" });
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      "pulse-day-mean",
      { action: "rebuild" },
      expect.anything(),
    );
    expect(
      vi.mocked(prisma.appSettings.upsert).mock.lastCall?.[0],
    ).toMatchObject({
      update: {
        pulseDayMeanDryRunJson: { rebuild: { status: "queued" } },
      },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "admin.pulseDayMean.rebuild",
      expect.anything(),
    );
  });

  it("shows a rebuild left queued with no job behind it as failed", async () => {
    settings(
      {
        ...doneAt("2026-10-15T08:00:00.000Z"),
        rebuild: { ...failedRebuild, status: "running", finishedAt: null },
      },
      "weighted_hour_mean_v2",
      new Date("2026-10-15T09:00:00.000Z"),
    );
    const body = await (await get()).json();
    expect(body.data.lastRebuild.status).toBe("failed");
    expect(body.data.lastDryRun.status).toBe("done");
  });
});

describe("POST body", () => {
  it("is strict", async () => {
    expect((await post({ action: "apply", force: true })).status).toBe(422);
    expect((await post({ action: "purge" })).status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 503 without a background worker", async () => {
    vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    expect((await post({ action: "dry_run" })).status).toBe(503);
  });
});
