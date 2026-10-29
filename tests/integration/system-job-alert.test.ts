/**
 * The system job alert against a ledger pg-boss itself wrote (#1298).
 *
 * A background job of the instance that keeps failing pushes every admin
 * once, a reminder at most once a day while it keeps failing, and once when it
 * runs successfully again. Fewer failures than the streak, and queues that
 * have an account-facing surface of their own, push nothing. The streak
 * counts jobs, not retries, and is kept per account: one account failing
 * every hour beside accounts that succeed is one problem and one recovery,
 * and a job that does not run again is announced once, not every day.
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

async function runOnce(
  queue: string,
  outcome: "fail" | "complete",
  userId = "u",
  retryLimit = 0,
) {
  const id = await boss.send(
    queue,
    { userId },
    { retryLimit, retryDelay: 0, retryBackoff: false },
  );
  if (!id) throw new Error("queue rejected the job");
  // Every attempt, retries included, until pg-boss settles the job.
  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    const [job] = await boss.fetch(queue);
    if (!job) throw new Error("nothing to fetch");
    if (outcome === "fail") {
      await boss.fail(
        queue,
        job.id,
        new Error(`canceling statement due to statement timeout (${userId})`),
      );
    } else {
      await boss.complete(queue, job.id, { ok: true });
      return;
    }
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

    // It fails once more; a day after the notice: one reminder.
    await runOnce(SYSTEM_QUEUE, "fail");
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

  it("counts a job that used up its retries as one failure", async () => {
    await makeUser({ role: "ADMIN" });
    await runOnce(SYSTEM_QUEUE, "fail", "u", 2);
    const outcome = await notifySystemJobFailures();
    expect(outcome.failing).toBe(0);
    expect(outcome.sent).toEqual([]);
  });

  it("tells once about one account failing every hour beside accounts that succeed", async () => {
    await makeUser({ role: "ADMIN" });
    const start = Date.now();
    const sent: string[] = [];
    // Ten hours: account `a` fails every hour, the others succeed after it,
    // so the queue's newest job is always a success.
    for (let hour = 0; hour < 10; hour++) {
      await runOnce(SYSTEM_QUEUE, "fail", "a");
      await runOnce(SYSTEM_QUEUE, "complete", "b");
      await runOnce(SYSTEM_QUEUE, "complete", "c");
      const outcome = await notifySystemJobFailures(
        new Date(start + hour * HOUR_MS),
      );
      sent.push(...outcome.sent.map((n) => n.kind));
    }
    expect(sent).toEqual(["problem"]);
    expect(String(dispatched.calls[0].params?.error)).toContain("(a)");

    // `a` succeeds: one recovery.
    await runOnce(SYSTEM_QUEUE, "complete", "a");
    const recovered = await notifySystemJobFailures(
      new Date(start + 10 * HOUR_MS),
    );
    expect(recovered.sent).toEqual([
      { queue: SYSTEM_QUEUE, kind: "recovered" },
    ]);
  });

  it("does not remind about a job that has not run again since the notice", async () => {
    await makeUser({ role: "ADMIN" });
    for (let i = 0; i < SYSTEM_JOB_FAILURE_STREAK; i++) {
      await runOnce(SYSTEM_QUEUE, "fail");
    }
    const now = new Date(Date.now() + 1_000);
    expect((await notifySystemJobFailures(now)).sent).toEqual([
      { queue: SYSTEM_QUEUE, kind: "problem" },
    ]);
    for (const days of [1, 2, 5]) {
      const later = await notifySystemJobFailures(
        new Date(now.getTime() + days * 24 * HOUR_MS),
      );
      expect(later.failing).toBe(1);
      expect(later.sent).toEqual([]);
    }
  });
});
