/**
 * Every way a restore job can end serialises into a job outcome.
 *
 * `runJob` validates what a handler returns before pg-boss persists it: fact
 * keys from an allowlist, string values lower-case words joined by
 * underscores. Two of the restore's failure codes are the dotted envelope
 * codes the console branches on (`backup.section.missing`,
 * `backup.payload.undecryptable`). Returned as they are, the validation
 * throws, the job fails with a TypeError, and a restore that correctly
 * refused an incomplete file reads as a crash in the operator's job card.
 * The integration tests call the handler body directly and cannot see it.
 *
 * Mutation check: return `outcome.code` unmapped in `runBackupRestoreJob`
 * (drop `jobFactCode`) and the dotted cases here go red.
 */
import { describe, expect, it } from "vitest";

import {
  jobFactCode,
  type BackupRestoreFailureCode,
} from "@/lib/jobs/backup-restore";
import {
  jobDone,
  jobFailed,
  serializeJobOutcome,
} from "@/lib/jobs/job-outcome";

// A record over the union, so a code added to it without a row here does not
// compile.
const CODE_TABLE: Record<BackupRestoreFailureCode, true> = {
  backup_not_found: true,
  backup_changed: true,
  "backup.payload.undecryptable": true,
  schema_invalid: true,
  incompatible_schema_version: true,
  owner_mismatch: true,
  owner_not_found: true,
  "backup.section.missing": true,
  document_ciphertext_missing: true,
  time_budget: true,
  transaction_failed: true,
  interrupted: true,
  not_started: true,
  enqueue_failed: true,
  failed_after_commit: true,
  unexpected: true,
};
const CODES = Object.keys(CODE_TABLE) as BackupRestoreFailureCode[];

describe("restore job outcomes serialise", () => {
  it.each(CODES)("a refusal with code %s", (code) => {
    expect(() =>
      serializeJobOutcome(jobDone({ refused: jobFactCode(code) })),
    ).not.toThrow();
  });

  it("the raw dotted code would not, which is why it is mapped", () => {
    expect(() =>
      serializeJobOutcome(jobDone({ refused: "backup.section.missing" })),
    ).toThrow();
  });

  it("the success, claim and sweep facts", () => {
    const facts: Array<Record<string, number | boolean>> = [
      { restore_measurements: 1_250_000, restore_skipped_links: 0 },
      { restore_claimed: false },
      { restore_requeued: 1, restore_failed: 0 },
    ];
    for (const did of facts) {
      expect(() => serializeJobOutcome(jobDone(did))).not.toThrow();
    }
  });

  it("the transaction failure", () => {
    expect(() =>
      serializeJobOutcome(jobFailed("restore_transaction_failed")),
    ).not.toThrow();
  });
});
