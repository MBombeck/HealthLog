/**
 * At most one waiting admission job per import, against a real pg-boss.
 *
 * A slice that met a provider outage is sent again hours later under the key
 * `<identity>|slice-N`. Boot discovery offers the same import under the bare
 * `<identity>`, so pg-boss's singleton saw two different keys and admitted
 * both: a deploy inside the backoff started a second chain on the same
 * progress note, with every provider call made twice. Every send of a fresh
 * offer or a retry now runs under a per-import lock and goes out only when
 * no other job of the import waits.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgBoss, type Job } from "pg-boss";

import {
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  type IntegrationBackfillAdmissionPayload,
  type IntegrationBackfillData,
} from "@/lib/jobs/integration-backfill-admission";
import { forwardToBackfillAdmission } from "@/lib/jobs/integration-backfill-forward";
import { handleBackfillFailure } from "@/lib/jobs/integration-backfill-retry";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";

let boss: PgBoss;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let n = 0;
let userId = "";

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
  await boss.createQueue(INTEGRATION_BACKFILL_ADMISSION_QUEUE, {
    policy: "exclusive",
  });
  setGlobalBoss(boss);
}, 120_000);

afterAll(async () => {
  setGlobalBoss(null);
  await boss?.stop({ graceful: false });
});

beforeEach(() => {
  n += 1;
  userId = `one-waiting-${suffix}-${n}`;
});

/** The jobs of this test's import that wait to run. */
async function waiting(): Promise<string[]> {
  const jobs = await boss.findJobs<IntegrationBackfillAdmissionPayload>(
    INTEGRATION_BACKFILL_ADMISSION_QUEUE,
    { queued: true },
  );
  return jobs
    .filter((j) => j.data.data.userId === userId)
    .map((j) => j.singletonKey ?? "")
    .sort();
}

function transient500(): Error {
  return Object.assign(new Error("fetch failed"), { name: "TimeoutError" });
}

function failingJob(slice: number): Job<IntegrationBackfillAdmissionPayload> {
  return {
    id: `failing-${slice}`,
    data: {
      kind: "garmin-backfill",
      data: { userId, enqueuedAt: new Date().toISOString(), slice },
    },
    retryCount: 0,
  } as unknown as Job<IntegrationBackfillAdmissionPayload>;
}

function discoveryJob(): Job<IntegrationBackfillData> {
  return {
    id: `discovery-${userId}`,
    data: { userId, enqueuedAt: new Date().toISOString() },
  } as unknown as Job<IntegrationBackfillData>;
}

const forward = () =>
  forwardToBackfillAdmission(boss, "garmin-backfill")([discoveryJob()]);

describe("one waiting job per import", () => {
  it("boot discovery offers nothing while a retry of the import waits", async () => {
    const outcome = await handleBackfillFailure(failingJob(3), transient500());
    expect(outcome).toEqual({ handled: true });
    const identity = `garmin-backfill|${userId}`;
    expect(await waiting()).toEqual([`${identity}|slice-4`]);

    // Two workers boot at once, each running discovery.
    await Promise.all([forward(), forward()]);
    expect(await waiting()).toEqual([`${identity}|slice-4`]);
  });

  it("a retry sends nothing while a fresh offer of the import waits, and the job completes", async () => {
    await forward();
    const identity = `garmin-backfill|${userId}`;
    expect(await waiting()).toEqual([identity]);

    const outcome = await handleBackfillFailure(failingJob(2), transient500());
    expect(outcome).toEqual({ handled: true });
    expect(await waiting()).toEqual([identity]);
  });

  it("racing a retry against discovery leaves exactly one waiting job", async () => {
    for (let round = 0; round < 5; round += 1) {
      n += 1;
      userId = `one-waiting-${suffix}-${n}`;
      await Promise.all([
        forward(),
        handleBackfillFailure(failingJob(1), transient500()),
        forward(),
      ]);
      expect(await waiting()).toHaveLength(1);
    }
  });
});
