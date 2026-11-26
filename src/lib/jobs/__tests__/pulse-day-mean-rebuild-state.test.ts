/**
 * The pulse rollup rebuild is on the record: a stopped one reads as failed
 * beside the dry run, so the admin card can offer it again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  let stored: unknown = {
    status: "done",
    startedAt: "2026-10-15T08:00:00.000Z",
    finishedAt: "2026-10-15T08:10:00.000Z",
    result: null,
  };
  return {
    get stored() {
      return stored;
    },
    reset(value: unknown) {
      stored = value;
    },
    appSettings: {
      findUnique: vi.fn(async () => ({ pulseDayMeanDryRunJson: stored })),
      upsert: vi.fn(
        async (args: { update: { pulseDayMeanDryRunJson: unknown } }) => {
          stored = args.update.pulseDayMeanDryRunJson;
          return {};
        },
      ),
    },
    $queryRaw: vi.fn(),
  };
});

// The read-merge-write runs under the settings row's lock; here the
// transaction client is the mocked one.
vi.mock("@/lib/app-settings-row-lock", async () => {
  const { prisma } = await import("@/lib/db");
  return {
    withAppSettingsRowLock: (fn: (tx: unknown) => unknown) => fn(prisma),
    lockAppSettingsRow: async () => {},
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { appSettings: db.appSettings, $queryRaw: db.$queryRaw },
}));
vi.mock("@/lib/jobs/job-lock", () => ({
  withJobLock: async (_key: string, run: () => Promise<unknown>) => ({
    ran: true,
    result: await run(),
  }),
}));
vi.mock("@/lib/logging/signal", () => ({ logCaught: vi.fn() }));

import { handlePulseDayMean } from "../pulse-day-mean";

const job = [{ data: { action: "rebuild" } }] as never;

beforeEach(() => {
  db.$queryRaw.mockReset();
});

describe("the pulse rebuild state", () => {
  it("records a stopped rebuild as failed, beside the dry run", async () => {
    db.$queryRaw.mockRejectedValue(new Error("statement timeout"));
    const outcome = await handlePulseDayMean(job);
    expect(outcome.ok).toBe(false);
    expect(db.stored).toMatchObject({
      status: "done",
      rebuild: { status: "failed", accounts: null },
    });
  });

  it("records a finished rebuild with what it did", async () => {
    // No account holds pulse: done, nothing written.
    db.$queryRaw.mockResolvedValue([]);
    const outcome = await handlePulseDayMean(job);
    expect(outcome.ok).toBe(true);
    expect(db.stored).toMatchObject({
      rebuild: { status: "done", accounts: 0, rows: 0 },
    });
  });
});
