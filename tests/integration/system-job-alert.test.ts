/**
 * The system job alert against a ledger pg-boss itself wrote (#1298).
 *
 * A background job of the instance that keeps failing pushes every admin
 * once, a reminder at most once a day while it keeps failing, and once when it
 * runs successfully again. Fewer failures than the streak, and queues that
 * have an account-facing surface of their own, push nothing.
 *
 * pg-boss provisions its own schema here and the jobs are failed and completed
 * through its own API, as in `job-failures.test.ts`, so the reader is proven
 * against the table pg-boss writes rather than one the test wrote.
 */
import { PgBoss } from "pg-boss";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const dispatched = vi.hoisted(() => ({
  calls: [] as Array<{
    userId: string;
    titleKey: string;
    messageKey: string;
    params?: Record<string, string | number>;
    eventType?: string;
  }>,
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(
    async (opts: (typeof dispatched.calls)[number]) => {
      dispatched.calls.push(opts);
    },
  ),
}));

import {
  notifySystemJobFailures,
  SYSTEM_JOB_FAILURE_STREAK,
} from "@/lib/jobs/system-job-alert";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

const SYSTEM_QUEUE = "rollup-full-backfill";
const ACCOUNT_QUEUE = "google-health-sync";
const HOUR_MS = 3_600_000;

let boss: PgBoss;

async function runOnce(queue: string, outcome: "fail" | "complete") {
  const id = await boss.send(queue, { userId: "u" }, { retryLimit: 0 });
  if (!id) throw new Error("queue rejected the job");
  const [job] = await boss.fetch(queue);
  if (!job) throw new Error("nothing to fetch");
  if (outcome === "fail") {
    await boss.fail(
      queue,
      job.id,
      new Error("canceling statement due to statement timeout"),
    );
  } else {
    await boss.complete(queue, job.id, { ok: true });
  }
}

beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  await boss.createQueue(SYSTEM_QUEUE);
  await boss.createQueue(ACCOUNT_QUEUE);
}, 60_000);

afterAll(async () => {
  await boss?.stop({ graceful: false, close: true });
  await getPrismaClient().$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS pgboss CASCADE`,
  );
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().$executeRawUnsafe(`DELETE FROM pgboss.job`);
  dispatched.calls.length = 0;
});

describe("notifySystemJobFailures", () => {
  it("tells every admin once, reminds a day later, and announces the recovery once", async () => {
    const admin = await makeUser({ role: "ADMIN" });
    const second = await makeUser({ role: "ADMIN" });
    await makeUser({ role: "USER" });
    for (let i = 0; i < SYSTEM_JOB_FAILURE_STREAK; i++) {
      await runOnce(SYSTEM_QUEUE, "fail");
    }
    const now = new Date();

    const first = await notifySystemJobFailures(now);
    expect(first.failing).toBe(1);
    expect(first.sent).toEqual([{ queue: SYSTEM_QUEUE, kind: "problem" }]);
    expect(dispatched.calls.map((c) => c.userId).sort()).toEqual(
      [admin.id, second.id].sort(),
    );
    const call = dispatched.calls[0];
    expect(call.eventType).toBe("SYSTEM_ALERT");
    expect(call.titleKey).toBe("notifications.systemJobAlert.titleFailing");
    expect(call.params).toMatchObject({
      queue: SYSTEM_QUEUE,
      failures: SYSTEM_JOB_FAILURE_STREAK,
    });
    expect(String(call.params?.error)).toContain("statement timeout");

    // The next hour: still failing, already told.
    dispatched.calls.length = 0;
    const again = await notifySystemJobFailures(
      new Date(now.getTime() + HOUR_MS),
    );
    expect(again.sent).toEqual([]);
    expect(dispatched.calls).toEqual([]);

    // A day later: one reminder.
    const reminder = await notifySystemJobFailures(
      new Date(now.getTime() + 25 * HOUR_MS),
    );
    expect(reminder.sent).toEqual([{ queue: SYSTEM_QUEUE, kind: "reminder" }]);

    // It runs again: one recovery notice, then silence.
    await runOnce(SYSTEM_QUEUE, "complete");
    dispatched.calls.length = 0;
    const recovered = await notifySystemJobFailures(
      new Date(now.getTime() + 26 * HOUR_MS),
    );
    expect(recovered.sent).toEqual([
      { queue: SYSTEM_QUEUE, kind: "recovered" },
    ]);
    expect(dispatched.calls[0].titleKey).toBe(
      "notifications.systemJobAlert.titleRecovered",
    );
    const quiet = await notifySystemJobFailures(
      new Date(now.getTime() + 27 * HOUR_MS),
    );
    expect(quiet.sent).toEqual([]);
  });

  it("stays quiet below the streak and for queues with an account-facing surface", async () => {
    await makeUser({ role: "ADMIN" });
    for (let i = 0; i < SYSTEM_JOB_FAILURE_STREAK - 1; i++) {
      await runOnce(SYSTEM_QUEUE, "fail");
    }
    for (let i = 0; i < SYSTEM_JOB_FAILURE_STREAK + 2; i++) {
      await runOnce(ACCOUNT_QUEUE, "fail");
    }
    const outcome = await notifySystemJobFailures();
    expect(outcome.failing).toBe(0);
    expect(outcome.sent).toEqual([]);
    expect(dispatched.calls).toEqual([]);
  });

  it("counts a success between failures as the end of the streak", async () => {
    await makeUser({ role: "ADMIN" });
    await runOnce(SYSTEM_QUEUE, "fail");
    await runOnce(SYSTEM_QUEUE, "fail");
    await runOnce(SYSTEM_QUEUE, "complete");
    await runOnce(SYSTEM_QUEUE, "fail");
    const outcome = await notifySystemJobFailures();
    expect(outcome.failing).toBe(0);
    expect(outcome.sent).toEqual([]);
  });
});
