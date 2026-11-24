/**
 * A new uniqueness rule is enforced on restore too.
 *
 * Migration 0515 made one live dose row per slot unique and merged the
 * duplicates it found in the database. It did not reach the backups written
 * before it: the stored copies, the nightly off-host copies and every file a
 * person downloaded. A restore of such a file met two live rows for one slot,
 * the insert failed on the new index, and the whole restore rolled back,
 * which is the way back the release notes point to when an update goes wrong.
 *
 * The class: a migration tightens or adds a unique key, and the restore path
 * does not normalise the rows of an older file the same way. So every unique
 * index a migration from 0514 on creates is listed here, with either
 *
 *   - `merge`: the integration test that restores an older file holding two
 *     rows the index refuses, and must find them merged (it must exist), or
 *   - `reason`: why a file can never hold two rows the index refuses (the
 *     table is not in the backup, or the index came with the table).
 *
 * A new unique index without an entry fails, and so does an entry whose index
 * is gone. The migration walk has a floor, so a matcher that finds nothing
 * fails instead of passing empty.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readSourceText } from "./helpers/source-files";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
/** The first migration this rule applies to; earlier files predate it. */
const FIRST = "0514";

const NOT_IN_BACKUP =
  "The table is excluded from the backup (the backup plan), so no file carries its rows.";
const CAME_WITH_TABLE =
  "The index was created with the table, so every file that carries the table's rows was written under it.";

type Decision = { merge: { provenBy: string } } | { reason: string };

const DECISIONS: Record<string, Decision> = {
  // `mergedIntakeEvents` in the restore, by the rule of `slot-merge`.
  medication_intake_events_user_med_slot_live_key: {
    merge: { provenBy: "dose-slot-merge" },
  },
  live_activity_tokens_device_id_push_token_key: { reason: NOT_IN_BACKUP },
  users_email_lower_key: {
    reason:
      "A restore writes into an existing account and never creates a user from the file; the upload route that creates one checks the name through the identity lookup.",
  },
  users_username_lower_key: {
    reason:
      "A restore writes into an existing account and never creates a user from the file; the upload route that creates one checks the name through the identity lookup.",
  },
  care_calendar_feeds_token_hash_key: { reason: NOT_IN_BACKUP },
  care_calendar_feeds_live_user_key: { reason: NOT_IN_BACKUP },
  push_relay_registrations_relay_host_key: { reason: NOT_IN_BACKUP },
  push_relay_deliveries_device_id_ref_key: { reason: NOT_IN_BACKUP },
  push_relay_unbinds_token_key: { reason: NOT_IN_BACKUP },
  devices_apns_token_lower_unique: { reason: NOT_IN_BACKUP },
  health_connect_remote_sources_user_id_key: { reason: NOT_IN_BACKUP },
  fhir_imported_resources_user_id_resource_type_resource_key_key: {
    reason: CAME_WITH_TABLE,
  },
  emergency_card_links_token_hash_key: { reason: NOT_IN_BACKUP },
  emergency_card_links_live_user_key: { reason: NOT_IN_BACKUP },
  emergency_card_links_live_user_purpose_key: { reason: NOT_IN_BACKUP },
  wallet_passes_link_id_key: { reason: NOT_IN_BACKUP },
  wallet_passes_serial_number_key: { reason: NOT_IN_BACKUP },
  wallet_pass_registrations_wallet_pass_id_device_library_id__key: {
    reason: NOT_IN_BACKUP,
  },
  ai_job_failures_user_id_job_subject_id_key: { reason: NOT_IN_BACKUP },
};

const UNIQUE_INDEX =
  /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/gi;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function uniqueIndexesIn(sql: string): string[] {
  return [...stripSqlComments(sql).matchAll(UNIQUE_INDEX)].map((m) => m[1]);
}

function newUniqueIndexes(): Map<string, string> {
  const found = new Map<string, string>();
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => /^\d{4}_/.test(d) && d.slice(0, 4) >= FIRST)
    .sort();
  if (dirs.length < 20) {
    throw new Error(`walked ${dirs.length} migrations from ${FIRST}`);
  }
  for (const dir of dirs) {
    const sql = readSourceText(join(MIGRATIONS, dir, "migration.sql"));
    for (const name of uniqueIndexesIn(sql)) found.set(name, dir);
  }
  return found;
}

describe("the matcher", () => {
  it("reads every way a unique index is written, and not in a comment", () => {
    expect(
      uniqueIndexesIn(`-- CREATE UNIQUE INDEX "commented" ON t (a);
        CREATE UNIQUE INDEX "plain" ON t (a);
        create unique index if not exists "guarded" on t (a);
        CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "online" ON t (a);
        CREATE INDEX "not_unique" ON t (a);`),
    ).toEqual(["plain", "guarded", "online"]);
  });
});

describe("unique indexes from 0514 on", () => {
  const found = newUniqueIndexes();

  it("each have a restore decision", () => {
    expect(found.size).toBeGreaterThanOrEqual(10);
    const missing = [...found.entries()]
      .filter(([name]) => !(name in DECISIONS))
      .map(([name, dir]) => `${dir}: ${name}`);
    expect(
      missing,
      "Say how a restore of an older file fits this index: a merge in the restore module, or why no file can break it.",
    ).toEqual([]);
  });

  it("list no index that no migration creates", () => {
    expect(Object.keys(DECISIONS).filter((n) => !found.has(n))).toEqual([]);
  });

  it("merge where they say they merge", () => {
    for (const [name, decision] of Object.entries(DECISIONS)) {
      if (!("merge" in decision)) continue;
      const test = [decision.merge.provenBy, "test", "ts"].join(".");
      expect(
        existsSync(join(process.cwd(), "tests", "integration", test)),
        `${name}: ${test}`,
      ).toBe(true);
    }
  });
});
