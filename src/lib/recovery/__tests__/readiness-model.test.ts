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
  evaluateDumpRetention,
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
  // A directory that cannot be written keeps nothing either.
  const writable = rest.localDirWritable ?? true;
  return {
    enabled: true,
    directory: "/data/db-backups",
    keepNightly: 7,
    localDirWritable: true,
    localPersistent: writable,
    localReason: writable ? "volume" : "not_writable",
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
    offhost: { lastUploadAt: null, failure: null },
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
      databaseLifecycle: { state: "configured", expirationDays: 30 },
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

  it("does not apply while no dump is scheduled", () => {
    expect(evalDump(null)).toMatchObject({
      state: "inactive",
      reason: "not_available",
    });
  });

  it("calls a switched-off dump attention, once, unless it could never write one", () => {
    expect(evalDump(dump({ enabled: false }))).toMatchObject({
      state: "attention",
      reason: "disabled",
    });
    // Never ran, but a bucket could take it: still a choice worth naming.
    expect(
      evalDump(
        dump({
          enabled: false,
          lastGoodAt: null,
          localDirWritable: false,
          offhostConfigured: true,
        }),
      ).state,
    ).toBe("attention");
    // Never ran and nowhere to write: switched off what it could not do.
    expect(
      evalDump(
        dump({ enabled: false, lastGoodAt: null, localDirWritable: false }),
      ),
    ).toMatchObject({ state: "inactive", reason: "disabled" });
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

  // The run that kept its dump here and failed its upload is the newest good
  // dump and the newest failure at the same instant; read as only those two,
  // it looked fresh while nothing reached the bucket.
  it("says when the bucket did not get the newest dump, and fails once its copy there is stale", () => {
    const keptAt = ago(2 * HOUR);
    const uploadFailed = (lastUploadAt: Date | null) =>
      dump({
        offhostConfigured: true,
        lastGoodAt: keptAt,
        lastFailureAt: keptAt,
        lastFailureReason: "off-host upload failed: AccessDenied",
        offhost: {
          lastUploadAt: lastUploadAt?.toISOString() ?? null,
          failure: {
            at: keptAt.toISOString(),
            error: "off-host upload failed: AccessDenied",
          },
        },
      });
    expect(evalDump(uploadFailed(ago(26 * HOUR)))).toMatchObject({
      state: "attention",
      reason: "offhost_failed",
      detail: "off-host upload failed: AccessDenied",
    });
    expect(
      evalDump(uploadFailed(ago(DUMP_FAILING_AFTER_HOURS * HOUR + 1))),
    ).toMatchObject({
      state: "failing",
      reason: "offhost_stale",
      params: { hours: 36 },
    });
    expect(evalDump(uploadFailed(null))).toMatchObject({
      state: "failing",
      reason: "offhost_never",
    });
    // A bucket nobody configured is not missing a dump.
    expect(
      evalDump({ ...uploadFailed(null), offhostConfigured: false }),
    ).toMatchObject({ state: "attention", reason: "last_failed" });
  });

  it("names a failure after the newest dump at the same instant, such as retention throwing", () => {
    const keptAt = ago(2 * HOUR);
    expect(
      evalDump(
        dump({
          lastGoodAt: keptAt,
          lastFailureAt: keptAt,
          lastFailureReason: "EACCES: unlink",
        }),
      ),
    ).toMatchObject({
      state: "attention",
      reason: "last_failed",
      detail: "EACCES: unlink",
    });
  });

  it("calls an upload-only setup whose upload never worked never succeeded", () => {
    const at = ago(HOUR);
    expect(
      evalDump(
        dump({
          localDirWritable: true,
          localPersistent: false,
          localReason: "container_layer",
          offhostConfigured: true,
          lastGoodAt: null,
          lastFailureAt: at,
          offhost: {
            lastUploadAt: null,
            failure: { at: at.toISOString(), error: "AccessDenied" },
          },
        }),
        ago(2 * HOUR),
      ),
    ).toMatchObject({
      state: "failing",
      reason: "never_succeeded",
      detail: "AccessDenied",
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

  it("does not count a writable directory inside the container as a place to keep dumps", () => {
    const layer = {
      localDirWritable: true,
      localPersistent: false,
      localReason: "container_layer" as const,
    };
    // No bucket: the dumps written there are lost at the next update.
    expect(evalDump(dump(layer))).toMatchObject({
      state: "failing",
      reason: "not_persistent",
      params: { directory: "/data/db-backups" },
    });
    // A bucket: fine, and the tile says the bucket holds the only copy.
    expect(evalDump(dump({ ...layer, offhostConfigured: true }))).toMatchObject(
      {
        state: "ok",
        reason: "fresh_offhost_only",
        params: { directory: "/data/db-backups" },
      },
    );
    // The same directory on a volume reads as before.
    expect(evalDump(dump({ offhostConfigured: true }))).toMatchObject({
      state: "ok",
      reason: "fresh",
    });
    // Switched off with nowhere lasting to write: not news.
    expect(
      evalDump(dump({ ...layer, enabled: false, lastGoodAt: null })),
    ).toMatchObject({ state: "inactive", reason: "disabled" });
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

describe("dump retention in the bucket", () => {
  const goingOffhost = dump({ offhostConfigured: true });
  const evalRule = (
    databaseLifecycle: ReadinessInputs["offhost"]["databaseLifecycle"],
    d: ReadinessInputs["dump"] = goingOffhost,
    configured = true,
  ) =>
    evaluateDumpRetention({
      dump: d,
      offhost: { configured, databaseLifecycle, accounts: [] },
    });

  it("asks for a rule when dumps go to a bucket that never removes them", () => {
    expect(evalRule({ state: "missing", expirationDays: null })).toMatchObject({
      state: "attention",
      reason: "missing",
      fixPath: "/admin/backups",
    });
  });

  it("names the expiry when a rule covers database/, and stays quiet when the bucket will not say", () => {
    expect(evalRule({ state: "configured", expirationDays: 30 })).toMatchObject(
      { state: "ok", reason: "configured", params: { days: 30 } },
    );
    expect(evalRule({ state: "unknown", expirationDays: null })).toMatchObject({
      state: "ok",
      reason: "unknown",
    });
    expect(evalRule(null)).toMatchObject({ state: "ok", reason: "unknown" });
  });

  it("does not apply without a bucket, or while no dump goes to it", () => {
    const missing = { state: "missing", expirationDays: null } as const;
    expect(evalRule(missing, goingOffhost, false)).toMatchObject({
      state: "inactive",
      reason: "not_configured",
    });
    for (const d of [
      null,
      "unreadable" as const,
      dump({ offhostConfigured: false }),
      dump({ offhostConfigured: true, enabled: false }),
    ]) {
      expect(evalRule(missing, d)).toMatchObject({
        state: "inactive",
        reason: "no_offhost_dumps",
      });
    }
  });

  it("moves the overall verdict to attention on its own", () => {
    const r = evaluateRecoveryReadiness(
      inputs({
        dump: goingOffhost,
        offhost: {
          configured: true,
          databaseLifecycle: { state: "missing", expirationDays: null },
          accounts: [
            { lastAttemptAt: ago(10 * HOUR), lastSuccessAt: ago(10 * HOUR) },
          ],
        },
      }),
    );
    expect(
      r.signals.filter((x) => x.state !== "ok" && x.state !== "inactive"),
    ).toEqual([expect.objectContaining({ id: "dump_retention" })]);
    expect(r.state).toBe("attention");
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
  ) =>
    evaluateOffhostCopies({
      now: NOW,
      offhost: { configured, databaseLifecycle: null, accounts },
    });

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
    evaluateRestoreDrill({
      offhost: { configured, databaseLifecycle: null, accounts: [] },
      drill: d,
    });
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
      offhost: { configured, databaseLifecycle: null, accounts: [] },
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
