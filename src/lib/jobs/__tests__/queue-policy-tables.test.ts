/**
 * Dead-policy guard, in the same spirit as the dead-queue guards.
 *
 * A queue's `singletonKey` only de-duplicates if its registry declaration
 * names a policy for it: pg-boss constrains `singleton_key` through partial
 * unique indexes scoped by queue policy, and the default `standard` policy
 * has none. So the enqueue site and the declaration are two halves of one
 * guarantee that live in different files, and nothing in the type system
 * couples them — dropping the declaration's policy leaves the `singletonKey`
 * at the call site looking entirely correct while it silently stops doing
 * anything.
 *
 * These assertions are that coupling. Each queue below is listed by its wire
 * name with the policy its call site depends on, and must be declared in the
 * named registry group; dropping or weakening an entry turns this suite red
 * instead of quietly restoring the storm.
 *
 * The behavioural proof that the policies mean what the names say lives in
 * `tests/integration/queue-singleton-policy.integration.test.ts`, which runs a
 * real pg-boss against a real Postgres.
 */
import { describe, expect, it } from "vitest";

import type { JobGroupName } from "@/lib/jobs/registry/define-job";
import {
  groupNamed,
  groupOf,
  jobOf,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

/** Assert that `queue` is declared in `group` with `policy`. */
function expectPolicy(group: JobGroupName, queue: string, policy: string) {
  expect(groupOf(queue).name).toBe(group);
  expect(
    jobOf(queue).policy?.policy,
    `${queue} must carry the "${policy}" policy — without it the singletonKey at its enqueue site is inert`,
  ).toBe(policy);
}

describe("rollup group queue policies", () => {
  // `short`, not `exclusive`: the handler re-reads the bucket when it starts,
  // so only QUEUED duplicates may be collapsed. Promoting either of these to
  // `exclusive` would strand a measurement written while a recompute ran.
  it.each([
    ["rollup-recompute", "short"],
    ["mood-rollup-recompute", "short"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy("rollup", queue, policy);
  });

  // Per-user, self-converging backfills: a second concurrent run is pure
  // duplicated work and discovery re-offers the job while it is outstanding.
  it.each([
    ["rollup-full-backfill", "exclusive"],
    ["mood-rollup-full-backfill", "exclusive"],
    ["step-consolidation", "exclusive"],
    ["step-consolidation-repair", "exclusive"],
    ["cumulative-pr-rederive", "exclusive"],
    ["mean-consolidation", "exclusive"],
    ["dense-intraday-retention", "exclusive"],
    ["dense-intraday-hourly-rebuild", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy("rollup", queue, policy);
  });
});

describe("status group queue policies", () => {
  it("morning-digest-refresh is exclusive", () => {
    // Seven sleep-write seams enqueue the same user+localDate key. Without
    // this the at-most-once-per-morning contract does not hold and the failure
    // path re-triggers forced comprehensive generations against the provider.
    expectPolicy("status", "morning-digest-refresh", "exclusive");
  });
});

describe("integration-sync group queue policies", () => {
  it.each([
    ["whoop-backfill", "exclusive"],
    ["fitbit-backfill", "exclusive"],
    ["google-health-backfill", "exclusive"],
    ["strava-backfill", "exclusive"],
    ["oura-backfill", "exclusive"],
    ["google-health-sleep-repair", "exclusive"],
    ["fitbit-sleep-repair", "exclusive"],
    ["sleep-timeline-backfill", "exclusive"],
    ["lab-biomarker-backfill", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy("integration_sync", queue, policy);
  });
});

describe("maintenance group queue policies", () => {
  it.each([
    ["intake-slot-dedup", "exclusive"],
    ["note-encryption-backfill", "exclusive"],
    ["med-notes-encryption-backfill", "exclusive"],
    ["free-text-encryption-backfill", "exclusive"],
    ["document-thumbnail-backfill", "exclusive"],
    ["document-content-index-backfill", "exclusive"],
    ["encryption-key-rotate", "exclusive"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy("maintenance", queue, policy);
  });

  // Per-document queues have no discovery pass to re-converge, so a re-process
  // requested after the running job read the old bytes must be admitted.
  it.each([
    ["document-index", "short"],
    ["document-thumbnail", "short"],
    ["document-summary", "short"],
  ])("%s is %s", (queue, policy) => {
    expectPolicy("maintenance", queue, policy);
  });

  // One-shot repairs on a fixed singleton key: a boot during a run must be
  // able to queue the next pass, so only queued duplicates collapse.
  it.each([["lab-document-date-repair", "short"]])(
    "%s is %s",
    (queue, policy) => {
      expectPolicy("maintenance", queue, policy);
    },
  );

  it("environment-fetch is deliberately left on standard", () => {
    // Its explicit-range backfill sends with no key at all, on purpose, so any
    // policy would collapse two different requested date ranges onto the shared
    // empty key. A future reader must not "complete" the declaration and
    // silently merge them.
    expect(groupOf("environment-fetch").name).toBe("maintenance");
    expect(jobOf("environment-fetch").policy).toBeUndefined();
  });
});

describe("every policy decision carries a reason", () => {
  it.each(["rollup", "status", "integration_sync", "maintenance"] as const)(
    "%s",
    (name) => {
      const decided = groupNamed(name).jobs.filter((job) => job.policy);
      expect(decided.length).toBeGreaterThan(0);
      // A policy without a stated reason is the thing this whole change exists
      // to prevent: the next person re-deriving intent from the call sites.
      for (const job of decided) {
        expect(job.policy!.reason.trim(), job.queue).not.toBe("");
      }
    },
  );
});
