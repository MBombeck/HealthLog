/**
 * The recovery readiness thresholds, one signal at a time, on both sides of
 * every line the model draws.
 *
 * Mutation check: move any threshold by one unit (35 h for the dump, 8 or 13
 * days for the weekly copy, 6 days of setup grace) and the matching
 * "just inside" or "just past" case goes red.
 */
import { describe, expect, it } from "vitest";

import type { DatabaseBackupHealth } from "@/lib/recovery/database-dump-health";
import {
  DUMP_FAILING_AFTER_HOURS,
  evaluateDatabaseDump,
  evaluateOffhostCopies,
  evaluateOffhostSetup,
  evaluateRecoveryKit,
  evaluateRecoveryReadiness,
  evaluateRestoreDrill,
  evaluateWeeklyCopy,
  READINESS_FIX_PATHS,
  READINESS_SIGNALS,
  SETUP_GRACE_DAYS,
  WEEKLY_COPY_ATTENTION_AFTER_DAYS,
  WEEKLY_COPY_FAILING_AFTER_DAYS,
  type ReadinessInputs,
} from "@/lib/recovery/readiness-model";

const NOW = new Date("2026-10-25T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A dump report in the dump module's own shape. */
function dump(
  over: Partial<DatabaseBackupHealth> & {
    lastGoodAt?: Date | null;
    lastFailureAt?: Date | null;
    lastFailureReason?: string;
  } = {},
): DatabaseBackupHealth {
  const {
    lastGoodAt = ago(2 * HOUR),
    lastFailureAt = null,
    lastFailureReason,
    ...rest
  } = over;
  return {
    enabled: true,
    directory: "/data/db-backups",
    localDirWritable: true,
    offhostConfigured: false,
    lastGood: lastGoodAt
      ? {
          at: lastGoodAt.toISOString(),
          fileName: "healthlog.dump.enc",
          sizeBytes: 1024,
          local: true,
          offhost: false,
        }
      : null,
    lastFailure: lastFailureAt
      ? {
          at: lastFailureAt.toISOString(),
          error: lastFailureReason ?? "failed",
        }
      : null,
    ...rest,
  };
}

function inputs(over: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return {
    now: NOW,
    firstAdminAt: ago(30 * DAY),
    dump: null,
    dumpWatchedSince: null,
    weekly: { accounts: [{ createdAt: ago(60 * DAY), lastCopyAt: ago(DAY) }] },
    offhost: {
      configured: true,
      accounts: [
        { lastAttemptAt: ago(10 * HOUR), lastSuccessAt: ago(10 * HOUR) },
      ],
    },
    drill: null,
    kit: { confirmedAt: ago(10 * DAY), unconfirmed: [] },
    ...over,
  };
}

describe("database dump", () => {
  const evalDump = (d: ReadinessInputs["dump"], watched: Date | null = null) =>
    evaluateDatabaseDump({ now: NOW, dump: d, dumpWatchedSince: watched });

  it("does not apply while no dump is scheduled, or while it is switched off", () => {
    expect(evalDump(null)).toMatchObject({
      state: "inactive",
      reason: "not_available",
    });
    expect(evalDump(dump({ enabled: false }))).toMatchObject({
      state: "inactive",
      reason: "disabled",
    });
  });

  it("fails when its status cannot be read", () => {
    expect(evalDump("unreadable")).toMatchObject({
      state: "failing",
      reason: "unreadable",
    });
  });

  it("is ok up to 36 hours and failing past them", () => {
    const inside = evalDump(
      dump({ lastGoodAt: ago(DUMP_FAILING_AFTER_HOURS * HOUR - 1) }),
    );
    expect(inside).toMatchObject({ state: "ok", reason: "fresh" });
    const past = evalDump(
      dump({ lastGoodAt: ago(DUMP_FAILING_AFTER_HOURS * HOUR + 1) }),
    );
    expect(past).toMatchObject({
      state: "failing",
      reason: "stale",
      params: { hours: 36 },
    });
    expect(past.at).toBe(
      ago(DUMP_FAILING_AFTER_HOURS * HOUR + 1).toISOString(),
    );
  });

  it("calls a recent failure after a recent dump attention, with the reason", () => {
    const s = evalDump(
      dump({ lastFailureAt: ago(HOUR), lastFailureReason: "pg_dump exited 1" }),
    );
    expect(s).toMatchObject({
      state: "attention",
      reason: "last_failed",
      detail: "pg_dump exited 1",
    });
  });

  it("fails when a dump can be kept nowhere, and accepts a bucket-only setup", () => {
    expect(evalDump(dump({ localDirWritable: false }))).toMatchObject({
      state: "failing",
      reason: "nowhere_to_write",
      params: { directory: "/data/db-backups" },
    });
    expect(
      evalDump(dump({ localDirWritable: false, offhostConfigured: true }))
        .state,
    ).toBe("ok");
  });

  it("gives a newly switched-on dump 36 hours before calling it failing", () => {
    const fresh = dump({ lastGoodAt: null });
    expect(evalDump(fresh, ago(HOUR))).toMatchObject({
      state: "ok",
      reason: "first_pending",
    });
    expect(evalDump(fresh, null)).toMatchObject({
      state: "ok",
      reason: "first_pending",
    });
    expect(evalDump(fresh, ago(37 * HOUR))).toMatchObject({
      state: "failing",
      reason: "never_ran",
    });
    expect(
      evalDump(dump({ lastGoodAt: null, lastFailureAt: ago(HOUR) }), ago(HOUR)),
    ).toMatchObject({ state: "failing", reason: "never_succeeded" });
  });
});

describe("weekly copy", () => {
  const weekly = (
    ...accounts: Array<{ createdAt: Date; lastCopyAt: Date | null }>
  ) => evaluateWeeklyCopy({ now: NOW, weekly: { accounts } });

  it("is attention past 9 days and failing past 14, judged by the worst account", () => {
    const fresh = { createdAt: ago(90 * DAY), lastCopyAt: ago(DAY) };
    expect(
      weekly(fresh, { createdAt: ago(90 * DAY), lastCopyAt: ago(9 * DAY - 1) })
        .state,
    ).toBe("ok");
    expect(
      weekly(fresh, {
        createdAt: ago(90 * DAY),
        lastCopyAt: ago(WEEKLY_COPY_ATTENTION_AFTER_DAYS * DAY + 1),
      }),
    ).toMatchObject({
      state: "attention",
      reason: "stale",
      params: { days: 9, accounts: 1 },
    });
    expect(
      weekly(fresh, {
        createdAt: ago(90 * DAY),
        lastCopyAt: ago(WEEKLY_COPY_FAILING_AFTER_DAYS * DAY - 1),
      }).state,
    ).toBe("attention");
    expect(
      weekly(fresh, {
        createdAt: ago(90 * DAY),
        lastCopyAt: ago(WEEKLY_COPY_FAILING_AFTER_DAYS * DAY + 1),
      }),
    ).toMatchObject({ state: "failing", params: { days: 14 } });
  });

  it("ages an account without any copy from its creation", () => {
    expect(weekly({ createdAt: ago(3 * DAY), lastCopyAt: null })).toMatchObject(
      {
        state: "ok",
        reason: "first_pending",
      },
    );
    expect(
      weekly({ createdAt: ago(20 * DAY), lastCopyAt: null }),
    ).toMatchObject({
      state: "failing",
      reason: "never",
    });
  });

  it("does not apply without accounts", () => {
    expect(weekly().state).toBe("inactive");
  });
});

describe("off-host copies", () => {
  const offhost = (
    configured: boolean,
    ...accounts: Array<{
      lastAttemptAt: Date | null;
      lastSuccessAt: Date | null;
    }>
  ) => evaluateOffhostCopies({ now: NOW, offhost: { configured, accounts } });

  it("does not apply while no bucket is configured", () => {
    expect(offhost(false).state).toBe("inactive");
  });

  it("calls any account more than two nights behind attention", () => {
    const fresh = {
      lastAttemptAt: ago(5 * HOUR),
      lastSuccessAt: ago(5 * HOUR),
    };
    // One missed night (inside two periods plus the grace) is not yet news.
    expect(
      offhost(true, fresh, {
        lastAttemptAt: ago(HOUR),
        lastSuccessAt: ago(40 * HOUR),
      }).state,
    ).toBe("ok");
    expect(
      offhost(true, fresh, {
        lastAttemptAt: ago(HOUR),
        lastSuccessAt: ago(2 * DAY + 7 * HOUR),
      }),
    ).toMatchObject({
      state: "attention",
      reason: "stale",
      params: { accounts: 1 },
    });
  });

  it("counts an account a run reached and never wrote as behind", () => {
    expect(
      offhost(true, { lastAttemptAt: ago(HOUR), lastSuccessAt: null }),
    ).toMatchObject({ state: "attention", params: { accounts: 1 } });
  });

  it("waits for the first run rather than calling the cohort behind", () => {
    expect(
      offhost(true, { lastAttemptAt: null, lastSuccessAt: null }),
    ).toMatchObject({
      state: "ok",
      reason: "first_pending",
    });
  });
});

describe("restore drill", () => {
  const drill = (d: ReadinessInputs["drill"], configured = true) =>
    evaluateRestoreDrill({ offhost: { configured, accounts: [] }, drill: d });
  const run = {
    lastRunAt: ago(5 * DAY),
    lastSuccessAt: null as Date | null,
    lastFailureAt: null as Date | null,
    lastFailureReason: null as string | null,
    accountsChecked: 3,
    accountsFailed: 0,
  };

  it("stays failing after a failure, with no time window, until a later success", () => {
    const failed = {
      ...run,
      lastFailureAt: ago(60 * DAY),
      accountsFailed: 1,
      lastFailureReason: "bad tag",
    };
    expect(drill(failed)).toMatchObject({
      state: "failing",
      reason: "failed",
      params: { failed: 1, checked: 3 },
      detail: "bad tag",
    });
    expect(drill({ ...failed, lastSuccessAt: ago(61 * DAY) }).state).toBe(
      "failing",
    );
    expect(drill({ ...failed, lastSuccessAt: ago(DAY) })).toMatchObject({
      state: "ok",
      reason: "passed",
    });
  });

  it("names a run that checked nothing", () => {
    expect(
      drill({ ...run, accountsChecked: 0, lastFailureAt: ago(DAY) }).reason,
    ).toBe("failed_run");
  });

  it("does not apply without a bucket, and is ok before its first run", () => {
    expect(drill(null, false).state).toBe("inactive");
    expect(drill(null)).toMatchObject({ state: "ok", reason: "not_run_yet" });
  });
});

describe("off-host setup", () => {
  const setup = (configured: boolean, firstAdminAt: Date | null) =>
    evaluateOffhostSetup({
      now: NOW,
      firstAdminAt,
      offhost: { configured, accounts: [] },
    });

  it("asks for a bucket 7 days after the first admin exists", () => {
    expect(setup(false, ago(SETUP_GRACE_DAYS * DAY - 1))).toMatchObject({
      state: "ok",
      reason: "not_configured_grace",
    });
    expect(setup(false, ago(SETUP_GRACE_DAYS * DAY + 1))).toMatchObject({
      state: "attention",
      reason: "not_configured",
    });
    expect(setup(true, ago(90 * DAY)).state).toBe("ok");
    expect(setup(false, null).state).toBe("inactive");
  });
});

describe("recovery kit", () => {
  const kit = (
    confirmedAt: Date | null,
    unconfirmed: Array<{
      kind: "application" | "backup" | "token";
      id: string;
    }>,
    firstAdminAt: Date | null = ago(30 * DAY),
  ) =>
    evaluateRecoveryKit({
      now: NOW,
      firstAdminAt,
      kit: { confirmedAt, unconfirmed },
    });

  it("is ok while the confirmation covers every key", () => {
    expect(kit(ago(DAY), [])).toMatchObject({
      state: "ok",
      reason: "confirmed",
    });
  });

  it("names a needed key nobody confirmed, at once once a kit was confirmed", () => {
    expect(kit(ago(DAY), [{ kind: "application", id: "v1" }])).toMatchObject({
      state: "attention",
      reason: "out_of_date",
      params: { keys: "v1", count: 1 },
    });
  });

  it("gives a never-confirmed kit 7 days after setup", () => {
    const keys = [
      { kind: "application" as const, id: "v1" },
      { kind: "token" as const, id: "API_TOKEN_HMAC_KEY" },
    ];
    expect(kit(null, keys, ago(SETUP_GRACE_DAYS * DAY - 1))).toMatchObject({
      state: "ok",
      reason: "not_confirmed_grace",
    });
    expect(kit(null, keys, ago(SETUP_GRACE_DAYS * DAY + 1))).toMatchObject({
      state: "attention",
      reason: "not_confirmed",
      params: { keys: "v1, API_TOKEN_HMAC_KEY", count: 2 },
    });
  });
});

describe("the whole verdict", () => {
  it("is the worst applying signal, and inactive ones never count", () => {
    expect(evaluateRecoveryReadiness(inputs()).state).toBe("ok");
    expect(
      evaluateRecoveryReadiness(
        inputs({ dump: dump({ lastGoodAt: ago(40 * HOUR) }) }),
      ).state,
    ).toBe("failing");
    expect(
      evaluateRecoveryReadiness(
        inputs({
          kit: {
            confirmedAt: ago(DAY),
            unconfirmed: [{ kind: "backup", id: "abc" }],
          },
        }),
      ).state,
    ).toBe("attention");
  });

  it("reports every signal once, in order, each with a fix path", () => {
    const r = evaluateRecoveryReadiness(inputs());
    expect(r.signals.map((s) => s.id)).toEqual([...READINESS_SIGNALS]);
    for (const s of r.signals)
      expect(s.fixPath).toBe(READINESS_FIX_PATHS[s.id]);
    expect(r.evaluatedAt).toBe(NOW.toISOString());
  });
});
