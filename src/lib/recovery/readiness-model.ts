/**
 * Recovery readiness: can this instance be put back after a loss, judged from
 * every fact the server holds about its own copies, in one place.
 *
 * Every one of these facts used to be a pull, on a page nobody opens until the
 * day it matters. The weekly copy stopped for 46 days and showed a perfectly
 * ordinary row. A failed monthly drill was on the failing-jobs card three days
 * in thirty. An off-host bucket that was never configured showed only on the
 * backups page, and the key step confirmed one key of the several a restore
 * needs. A bucket whose lifecycle rule left `database/` out kept every dump,
 * and every deleted account inside it, forever, and only the backups page
 * said so. This module turns them into seven signals with one verdict each,
 * which the readiness tile shows and the hourly evaluation pushes to every
 * admin.
 *
 * Pure: the inputs are read elsewhere (`readiness.ts`), so each threshold is a
 * unit test away and the tile and the push cannot disagree about a verdict.
 *
 * States:
 *   ok        — nothing to do. A grace period (`*_grace` reasons) is ok too:
 *               the admin is shown the step, nobody is pushed about it yet.
 *   attention — something will hurt on the day of a restore; worth a push.
 *   failing   — the instance cannot be restored the way it is meant to be.
 *   inactive  — the signal does not apply here (no dump in this build, no
 *               off-host bucket for the drill). Never pushed, never counts
 *               towards the overall verdict.
 */
import {
  classifyOffhostBackup,
  type OffhostBackupFreshness,
} from "@/lib/jobs/offhost-backup-freshness";
import type { LifecycleVerdict } from "@/lib/jobs/offhost-lifecycle";
import { databaseDumpProblems } from "@/lib/database-backup/dump-problems";
import type { DatabaseBackupHealth } from "@/lib/recovery/database-dump-health";
import type { KitEntry } from "@/lib/recovery/kit-rules";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A dump older than this, while dumps are on, means no usable dump. */
export const DUMP_FAILING_AFTER_HOURS = 36;
/** The weekly copy runs every Sunday; past nine days one Sunday was missed. */
export const WEEKLY_COPY_ATTENTION_AFTER_DAYS = 9;
/** Past fourteen days two Sundays produced nothing for some account. */
export const WEEKLY_COPY_FAILING_AFTER_DAYS = 14;
/**
 * How long after the first admin exists the off-host bucket and the recovery
 * kit may stay unset before the admins are pushed about it.
 */
export const SETUP_GRACE_DAYS = 7;

export const READINESS_SIGNALS = [
  "database_dump",
  "weekly_copy",
  "offhost_copies",
  "restore_drill",
  "offhost_setup",
  "dump_retention",
  "recovery_kit",
] as const;
export type ReadinessSignalId = (typeof READINESS_SIGNALS)[number];

export const READINESS_STATES = [
  "ok",
  "attention",
  "failing",
  "inactive",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** Where each signal is fixed. Every path is an admin page. */
export const READINESS_FIX_PATHS: Record<ReadinessSignalId, string> = {
  database_dump: "/admin/backups",
  weekly_copy: "/admin/backups",
  offhost_copies: "/admin/backups",
  restore_drill: "/admin/backups",
  offhost_setup: "/admin/backups",
  dump_retention: "/admin/backups",
  recovery_kit: "/admin/encryption",
};

export interface ReadinessSignal {
  id: ReadinessSignalId;
  state: ReadinessState;
  /**
   * Why, as a closed code per signal. The tile and the push render it through
   * `admin.recoveryReadiness.<signal>.<reason>`, so it never carries prose.
   */
  reason: string;
  /** The instant the signal is about (the newest dump, the last drill). */
  at: string | null;
  /** Values the sentence for `reason` interpolates. Never key material. */
  params: Record<string, string | number>;
  /**
   * An operator-facing line from the source (a dump's or a drill's failure
   * text), already redacted where it was written. Shown in the tile only.
   */
  detail: string | null;
  fixPath: string;
}

export interface RecoveryReadiness {
  /** The worst state of the signals that apply; `ok` when none do. */
  state: Exclude<ReadinessState, "inactive">;
  evaluatedAt: string;
  signals: ReadinessSignal[];
}

/** What the evaluation reads, gathered by `readiness.ts`. */
export interface ReadinessInputs {
  now: Date;
  /** When the first admin account was created; null on an empty install. */
  firstAdminAt: Date | null;
  /**
   * `null` while no dump is scheduled by this build; `"unreadable"` when the
   * dump module threw while reporting, which is itself a failure to report.
   */
  dump: DatabaseBackupHealth | null | "unreadable";
  /**
   * Since when the evaluation has seen dumps switched on. A dump that has
   * never been attempted is judged against this, so an upgrade that turns
   * dumps on is not failing before the first run had a chance.
   */
  dumpWatchedSince: Date | null;
  weekly: {
    /** One entry per account: when it was created and its newest copy. */
    accounts: ReadonlyArray<{ createdAt: Date; lastCopyAt: Date | null }>;
  };
  offhost: {
    configured: boolean;
    /**
     * The bucket's lifecycle rules for keys under `database/`, as the backups
     * page reads them (`probeOffhostLifecycle`). Null when no bucket is
     * configured.
     */
    databaseLifecycle: LifecycleVerdict | null;
    accounts: ReadonlyArray<{
      lastAttemptAt: Date | null;
      lastSuccessAt: Date | null;
    }>;
  };
  drill: {
    lastRunAt: Date;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    lastFailureReason: string | null;
    accountsChecked: number;
    accountsFailed: number;
  } | null;
  kit: {
    /** A confirmation exists at all. */
    confirmedAt: Date | null;
    /** Keys the kit lists that the confirmation does not cover. */
    unconfirmed: ReadonlyArray<Pick<KitEntry, "kind" | "id">>;
  };
}

function signal(
  id: ReadinessSignalId,
  state: ReadinessState,
  reason: string,
  at: Date | null,
  params: Record<string, string | number> = {},
  detail: string | null = null,
): ReadinessSignal {
  return {
    id,
    state,
    reason,
    at: at?.toISOString() ?? null,
    params,
    detail,
    fixPath: READINESS_FIX_PATHS[id],
  };
}

const wholeHours = (ms: number) => Math.max(0, Math.floor(ms / HOUR_MS));
const wholeDays = (ms: number) => Math.max(0, Math.floor(ms / DAY_MS));

function setupGraceEndsAt(firstAdminAt: Date | null): Date | null {
  return firstAdminAt
    ? new Date(firstAdminAt.getTime() + SETUP_GRACE_DAYS * DAY_MS)
    : null;
}

export function evaluateDatabaseDump(
  input: Pick<ReadinessInputs, "now" | "dump" | "dumpWatchedSince">,
): ReadinessSignal {
  const { dump, now } = input;
  const id = "database_dump";
  if (dump === null) return signal(id, "inactive", "not_available", null);
  if (dump === "unreadable") return signal(id, "failing", "unreadable", null);
  const lastGoodAt = dump.lastGood ? new Date(dump.lastGood.at) : null;
  if (!dump.enabled) {
    // Dumps are on by default, so off is a choice someone made, and it
    // leaves no copy that rebuilds the host: worth one notice. An install
    // that never wrote a dump and has nowhere to write one (no writable
    // directory, no bucket) switched off what it could not do, which is not
    // news.
    const neverUsed = dump.lastGood === null && dump.lastFailure === null;
    const cannotWrite = !dump.localPersistent && !dump.offhostConfigured;
    return neverUsed && cannotWrite
      ? signal(id, "inactive", "disabled", null)
      : signal(id, "attention", "disabled", lastGoodAt);
  }
  const problems = databaseDumpProblems(dump);
  const lastFailureAt = problems.failure ? new Date(problems.failure.at) : null;
  const failureReason = problems.failure?.error ?? null;
  // A directory that keeps nothing (not writable, or writable inside the
  // container and lost at the next update) is a valid setup when the dumps
  // go to the bucket; with no bucket either, no dump is kept anywhere.
  if (!dump.localPersistent && !dump.offhostConfigured) {
    return signal(
      id,
      "failing",
      dump.localDirWritable ? "not_persistent" : "nowhere_to_write",
      lastGoodAt,
      { directory: dump.directory },
    );
  }
  const limitMs = DUMP_FAILING_AFTER_HOURS * HOUR_MS;
  const failedSinceGood = lastFailureAt !== null;
  if (lastGoodAt === null) {
    // Nothing kept anywhere yet; a dump that only failed its upload (no
    // directory that survives) has not succeeded either.
    const failed = problems.failure ?? problems.offhost;
    if (failed) {
      return signal(
        id,
        "failing",
        "never_succeeded",
        new Date(failed.at),
        {},
        failed.error,
      );
    }
    const watched = input.dumpWatchedSince ?? now;
    return now.getTime() - watched.getTime() > limitMs
      ? signal(id, "failing", "never_ran", null, {
          hours: DUMP_FAILING_AFTER_HOURS,
        })
      : signal(id, "ok", "first_pending", null);
  }
  const ageMs = now.getTime() - lastGoodAt.getTime();
  if (ageMs > limitMs) {
    return signal(
      id,
      "failing",
      "stale",
      lastGoodAt,
      { hours: wholeHours(ageMs) },
      failedSinceGood ? failureReason : null,
    );
  }
  // The dump is kept on this server, and the bucket configured for it did
  // not get it: the copy that outlives the host is missing. Past the same
  // limit as a stale dump, no copy off the host is recent enough to rebuild
  // from.
  if (problems.offhost) {
    const uploadedAt = problems.offhost.lastUploadAt
      ? new Date(problems.offhost.lastUploadAt)
      : null;
    if (uploadedAt === null) {
      return signal(
        id,
        "failing",
        "offhost_never",
        lastGoodAt,
        {},
        problems.offhost.error,
      );
    }
    const uploadAgeMs = now.getTime() - uploadedAt.getTime();
    return uploadAgeMs > limitMs
      ? signal(
          id,
          "failing",
          "offhost_stale",
          lastGoodAt,
          { hours: wholeHours(uploadAgeMs) },
          problems.offhost.error,
        )
      : signal(
          id,
          "attention",
          "offhost_failed",
          lastGoodAt,
          {},
          problems.offhost.error,
        );
  }
  if (failedSinceGood) {
    return signal(
      id,
      "attention",
      "last_failed",
      lastGoodAt,
      {},
      failureReason,
    );
  }
  // Fine, and worth saying: the bucket holds the only copy, and no dump is
  // taken before a migration.
  return dump.localPersistent
    ? signal(id, "ok", "fresh", lastGoodAt)
    : signal(id, "ok", "fresh_offhost_only", lastGoodAt, {
        directory: dump.directory,
      });
}

/**
 * The worst account decides. An account without any copy ages from its
 * creation, so a new account is not overdue before its first Sunday, and one
 * the pass keeps skipping becomes overdue like a stale copy would.
 */
export function evaluateWeeklyCopy(
  input: Pick<ReadinessInputs, "now" | "weekly">,
): ReadinessSignal {
  const id = "weekly_copy";
  const { now } = input;
  if (input.weekly.accounts.length === 0) {
    return signal(id, "inactive", "no_accounts", null);
  }
  let worstMs = -Infinity;
  let worst: { createdAt: Date; lastCopyAt: Date | null } | null = null;
  let overdue = 0;
  for (const account of input.weekly.accounts) {
    const ref = account.lastCopyAt ?? account.createdAt;
    const ageMs = now.getTime() - ref.getTime();
    if (ageMs > WEEKLY_COPY_ATTENTION_AFTER_DAYS * DAY_MS) overdue += 1;
    if (ageMs > worstMs) {
      worstMs = ageMs;
      worst = account;
    }
  }
  const days = wholeDays(worstMs);
  const at = worst?.lastCopyAt ?? null;
  const params = { days, accounts: overdue };
  if (worstMs > WEEKLY_COPY_FAILING_AFTER_DAYS * DAY_MS) {
    return signal(id, "failing", at ? "stale" : "never", at, params);
  }
  if (worstMs > WEEKLY_COPY_ATTENTION_AFTER_DAYS * DAY_MS) {
    return signal(id, "attention", at ? "stale" : "never", at, params);
  }
  // The oldest of the newest copies: the one a restore would be furthest
  // behind with. Null only while no account has been copied yet.
  const oldestCopy = input.weekly.accounts
    .map((a) => a.lastCopyAt)
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((min, d) => (min === null || d < min ? d : min), null);
  return signal(id, "ok", oldestCopy ? "fresh" : "first_pending", oldestCopy);
}

/**
 * Any account whose newest off-host object is two schedule periods old (the
 * freshness module's `stale`, which carries the DST and long-night grace), or
 * that a run reached and never put an object there.
 */
export function evaluateOffhostCopies(
  input: Pick<ReadinessInputs, "now" | "offhost">,
): ReadinessSignal {
  const id = "offhost_copies";
  if (!input.offhost.configured) {
    return signal(id, "inactive", "not_configured", null);
  }
  const verdicts: Array<{
    freshness: OffhostBackupFreshness;
    lastSuccessAt: Date | null;
  }> = input.offhost.accounts.map((a) => ({
    freshness: classifyOffhostBackup({
      lastAttemptAt: a.lastAttemptAt,
      lastSuccessAt: a.lastSuccessAt,
      now: input.now,
    }).freshness,
    lastSuccessAt: a.lastSuccessAt,
  }));
  const oldest = (rows: typeof verdicts) =>
    rows
      .map((r) => r.lastSuccessAt)
      .filter((d): d is Date => d !== null)
      .reduce<Date | null>(
        (min, d) => (min === null || d < min ? d : min),
        null,
      );
  const behind = verdicts.filter(
    (v) => v.freshness === "stale" || v.freshness === "never",
  );
  if (behind.length > 0) {
    return signal(id, "attention", "stale", oldest(behind), {
      accounts: behind.length,
    });
  }
  const seen = verdicts.filter((v) => v.freshness !== "unknown");
  if (seen.length === 0) return signal(id, "ok", "first_pending", null);
  return signal(id, "ok", "fresh", oldest(seen));
}

/** A failed drill stays the verdict until a later drill passes. */
export function evaluateRestoreDrill(
  input: Pick<ReadinessInputs, "offhost" | "drill">,
): ReadinessSignal {
  const id = "restore_drill";
  const { drill } = input;
  if (!input.offhost.configured) {
    return signal(id, "inactive", "not_configured", null);
  }
  if (drill === null) return signal(id, "ok", "not_run_yet", null);
  const failing =
    drill.lastFailureAt !== null &&
    (drill.lastSuccessAt === null || drill.lastFailureAt > drill.lastSuccessAt);
  if (failing) {
    return signal(
      id,
      "failing",
      // A drill that checked nothing stopped before any object: the bucket
      // could not be listed, or held nothing to check.
      drill.accountsChecked === 0 ? "failed_run" : "failed",
      drill.lastFailureAt,
      { failed: drill.accountsFailed, checked: drill.accountsChecked },
      drill.lastFailureReason,
    );
  }
  // The latest run read nothing back (it stopped on its budget before the
  // first object): no proof that a copy restores, whatever passed before.
  if (drill.accountsChecked === 0) {
    return signal(id, "attention", "nothing_checked", drill.lastRunAt);
  }
  return signal(id, "ok", "passed", drill.lastSuccessAt ?? drill.lastRunAt, {
    checked: drill.accountsChecked,
  });
}

export function evaluateOffhostSetup(
  input: Pick<ReadinessInputs, "now" | "firstAdminAt" | "offhost">,
): ReadinessSignal {
  const id = "offhost_setup";
  if (input.offhost.configured) return signal(id, "ok", "configured", null);
  const graceEnds = setupGraceEndsAt(input.firstAdminAt);
  if (graceEnds === null) return signal(id, "inactive", "no_admin", null);
  return input.now > graceEnds
    ? signal(id, "attention", "not_configured", null)
    : signal(id, "ok", "not_configured_grace", graceEnds);
}

/**
 * Whether the bucket ever removes the database dumps. Each one holds every
 * account that existed when it was taken, so a bucket with no rule for
 * `database/` keeps a deleted account's data for as long as the bucket
 * exists. Attention, not failing: every restore still works. A bucket that
 * will not say (a credential without the permission, a target without the
 * call) is not news either way.
 */
export function evaluateDumpRetention(
  input: Pick<ReadinessInputs, "dump" | "offhost">,
): ReadinessSignal {
  const id = "dump_retention";
  if (!input.offhost.configured) {
    return signal(id, "inactive", "not_configured", null);
  }
  const { dump } = input;
  const dumpsGoOffhost =
    dump !== null &&
    dump !== "unreadable" &&
    dump.enabled &&
    dump.offhostConfigured;
  if (!dumpsGoOffhost) {
    return signal(id, "inactive", "no_offhost_dumps", null);
  }
  const rule = input.offhost.databaseLifecycle;
  if (rule?.state === "missing") {
    return signal(id, "attention", "missing", null);
  }
  if (rule?.state === "configured" && rule.expirationDays !== null) {
    return signal(id, "ok", "configured", null, {
      days: rule.expirationDays,
    });
  }
  return signal(id, "ok", "unknown", null);
}

export function evaluateRecoveryKit(
  input: Pick<ReadinessInputs, "now" | "firstAdminAt" | "kit">,
): ReadinessSignal {
  const id = "recovery_kit";
  const { kit } = input;
  const keys = kit.unconfirmed.map((k) => k.id).join(", ");
  if (kit.unconfirmed.length === 0 && kit.confirmedAt !== null) {
    return signal(id, "ok", "confirmed", kit.confirmedAt);
  }
  if (kit.confirmedAt !== null) {
    // Confirmed once, and a key it needs is not in that confirmation: a
    // rotation, a new backup key, a re-keyed install. No grace: the keys are
    // already in use.
    return signal(id, "attention", "out_of_date", kit.confirmedAt, {
      keys,
      count: kit.unconfirmed.length,
    });
  }
  const graceEnds = setupGraceEndsAt(input.firstAdminAt);
  if (graceEnds === null) return signal(id, "inactive", "no_admin", null);
  return input.now > graceEnds
    ? signal(id, "attention", "not_confirmed", null, {
        keys,
        count: kit.unconfirmed.length,
      })
    : signal(id, "ok", "not_confirmed_grace", graceEnds, {
        keys,
        count: kit.unconfirmed.length,
      });
}

const SEVERITY: Record<Exclude<ReadinessState, "inactive">, number> = {
  ok: 0,
  attention: 1,
  failing: 2,
};

export function evaluateRecoveryReadiness(
  inputs: ReadinessInputs,
): RecoveryReadiness {
  const signals = [
    evaluateDatabaseDump(inputs),
    evaluateWeeklyCopy(inputs),
    evaluateOffhostCopies(inputs),
    evaluateRestoreDrill(inputs),
    evaluateOffhostSetup(inputs),
    evaluateDumpRetention(inputs),
    evaluateRecoveryKit(inputs),
  ];
  const state = signals.reduce<Exclude<ReadinessState, "inactive">>(
    (worst, s) =>
      s.state !== "inactive" && SEVERITY[s.state] > SEVERITY[worst]
        ? s.state
        : worst,
    "ok",
  );
  return { state, evaluatedAt: inputs.now.toISOString(), signals };
}
