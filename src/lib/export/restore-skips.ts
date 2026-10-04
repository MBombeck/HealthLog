/**
 * What a restore could not put back, and how much of it there was.
 *
 * Four of the restore's lookups resolve a key against a SEEDED CATALOGUE —
 * cycle symptoms, illness symptoms, rated mood factors and the mood tags a
 * person ticks present or absent. The catalogue is reference
 * data the instance owns, not data the file carries, so it legitimately drifts
 * between the day a backup is written and the day it is read: a key gets
 * renamed, a symptom is retired, the file is a year old, the instance is three
 * releases newer. That is the ordinary case for a backup, not a corrupt file.
 *
 * Each of those lookups used to throw, which rolled the whole transaction back
 * and answered 500 — one renamed symptom and the operator got none of the
 * account back. Before that they filtered the unresolvable key away and
 * reported success, which lost the same link with no trace at all. Neither is
 * honest: the first destroys a recoverable restore, the second hides a real
 * loss.
 *
 * So the unresolvable link is dropped and NAMED. This module is the naming.
 * Every drop lands here, and the accumulated report rides the restore response,
 * the audit row, and the wide event, so the count and the exact keys reach the
 * person who ran the restore instead of a log line nobody reads.
 *
 * What is dropped is deliberately narrow: one (row, symptom) association. The
 * day-log, the mood entry, the note, the flow, the temperature — everything the
 * row itself holds — comes back. A link table is the only place this applies,
 * because it is the only place where a value that will not resolve costs an
 * edge rather than a record.
 */

/**
 * Which lookup a key failed to resolve against.
 *
 * Four are seeded catalogues, as described above. The fifth, `visitReference`,
 * is a different kind of unresolvable and is here rather than in its own
 * mechanism because the cost and the honest response are identical: an edge is
 * lost, the record it hangs off survives, and the operator is told which one.
 * What it names is a row the file pointed at that the restore did not put
 * back — a reminder the file does not carry (a portable export omits
 * tombstoned ones since v1.37.20; before that no reminder travelled at all),
 * or a document, lab result or condition episode whose id a portable export
 * does not carry.
 *
 * The sixth, `vaccinationReference`, is the same kind as `visitReference` and
 * is kept separate rather than folded into it so the report says which part of
 * the record lost an edge. It names a row an immunization entry pointed at
 * that the restore did not put back — a booster reminder the file does not
 * carry, a practitioner or visit the file referenced without carrying, or a
 * scanned page whose id a portable export does not include.
 *
 * The seventh, `reminderReference`, is the same kind as the two above, for
 * the completion ledger (v1.37.20, #223 / iOS #68): a ledger row whose
 * reminder the file does not carry. The builder filters the ledger to carried
 * reminders at write time, so a file this release writes never trips it —
 * it exists for the hand-edited or truncated file, where inventing the
 * reminder and silently dropping the row are equally wrong.
 *
 * The eighth, `coachAttachment`, is the same kind again, for the join naming
 * which vault documents a Coach conversation was grounded in. The document is
 * restored before the conversations are, so a file this release writes always
 * resolves: a disaster-recovery payload carries every document, and a portable
 * payload never reaches a restore while the account has any, because the route
 * refuses it ahead of the wipe. It exists for the hand-edited or truncated
 * file, where inventing the document and silently dropping the provenance are
 * equally wrong.
 *
 * The ninth, `coachReference`, names a conversation or a plan that a Coach
 * fact, plan or reminder pointed at and the restore did not put back. It is
 * unlike every kind above in one way worth stating: neither `sourceConversationId`
 * nor `relatedPlanId` is a foreign key, so a dangling value costs no error and
 * simply stops meaning anything. What is dropped here is therefore the POINTER
 * and not the row — the fact, the plan and the reminder all restore, and the
 * reminder still fires. A portable export omits tombstoned plans, which is the
 * ordinary way a live reminder ends up naming one the file does not carry.
 *
 * The tenth and eleventh, `documentConditionLink` and `extractedFact`, name a
 * vault row whose parent the restore did not put back — the page a filing was
 * made against, the condition it was filed under, or the document a staged
 * fact was read out of. All three are real foreign keys, so unlike every kind
 * above the alternative to dropping the row is not a dangling pointer but an
 * aborted transaction and no restore at all. The builder carries a filing or a
 * fact only when both of its ends are carried, so a file this release writes
 * never trips either — they exist for the hand-edited or truncated file.
 *
 * The twelfth, `factCommitment`, is the pointer kind rather than the row kind,
 * exactly like `coachReference`: `ExtractedFact.committedRecordId` names the
 * lab result, condition episode or medication an approved fact was committed
 * to, and it is a bare id column with no relation, so a value pointing at
 * nothing costs no error and simply stops meaning anything. The fact itself
 * restores; what it loses is a pointer that was already going nowhere, and its
 * `committedRecordType` goes with it so the row does not claim a commitment it
 * cannot name.
 *
 * The thirteenth, `checkupClosure`, is not about a restore at all, and it borrows
 * The tenth, `personalRecordReference`, names the measurement a personal best
 * was found in. It reads like `coachReference` and is the opposite case in the
 * one way that matters: `PersonalRecord.sourceMeasurementId` LOOKS like a bare
 * id column in `prisma/schema.prisma`, which declares no relation for it, but
 * migration 0054 created it as a real foreign key against `measurements`. So a
 * dangling value here does not quietly stop meaning something. Postgres
 * refuses the statement and the whole restore rolls back over one provenance
 * pointer. What is dropped is therefore the POINTER and not the row: the best
 * itself is the historical fact, which is why the column was declared
 * `ON DELETE SET NULL` in the first place. The ordinary way it fails to
 * resolve is a portable export whose source measurement was soft-deleted, and
 * a legacy file whose measurements carry no ids at all.
 * The tenth, `ecgReference`, names the EVENT measurement an ECG strip was
 * filed against that the restore did not put back. Unlike `coachReference` it
 * is a real foreign key, so writing the dangling value would not quietly stop
 * meaning anything — it would violate the constraint and roll the whole
 * restore back over one cross-reference. What is dropped is the POINTER: the
 * strip, its instant and its rhythm verdict all restore. A portable export
 * omits soft-deleted measurements, which is the ordinary way a live recording
 * ends up naming one the file does not carry.
 *
 * The eleventh, `medicationTarget`, names the lab analyte a medication's
 * pinned efficacy target pointed at that the restore did not put back. It is
 * the one kind here where the ROW is dropped rather than the pointer, and the
 * reason is what the row is: an override exists only to say "this drug is for
 * that analyte", so an override with nothing on the far side states nothing.
 * The resolver already treats a target with neither arm set as "no override",
 * so writing one back would restore a row that means nothing and still claims
 * the primary slot. The drug, its schedule and its whole history come back;
 * what is lost is one statement of intent, and the operator is told which.
 *
 * The twelfth, `scheduleRevisionLink`, names a supersede pointer between two
 * archived schedule eras that the restore could not honour. Its key is a JSON
 * PATH into the file rather than an id, because the pointer travels as a
 * position in the drug's own era list and there is no id on either end that
 * the file and the database both know. Only a hand-edited or truncated file
 * can trip it: the builder writes a position it has just computed from the
 * same list. What is lost is the pointer and not the era — the window and the
 * plan it held still restore.
 *
 * The thirteenth, `checkupClosure`, is not about a restore at all, and it borrows
 * this shape deliberately rather than growing a second reporting mechanism
 * beside it. The situation is the same one: something a write was asked to do
 * could not be done, the record itself survives, and the person is told which
 * one rather than left to assume it worked. It is filed when a delegate files
 * a visit against a preventive-care checkup their grant does not reach — the
 * visit saves, the checkup stays due, and the response says so.
 *
 * The fourteenth, `accountSetting`, names one of the account's own settings
 * the file carried and this host would not write: an AI endpoint on a private
 * address this host has not allowed, a language or unit this release does not
 * know, a threshold out of range, an avatar the upload would refuse. Its key
 * is the column (or `column.part` for one band or one site), never the value.
 * The account keeps what it had for that setting; everything else comes back.
 *
 * The fifteenth, `symptomEpisodeReference`, names the illness episode a
 * symptom occurrence was filed against that the restore did not put back. A
 * real foreign key, so the POINTER is dropped and the occurrence restores
 * unlinked. A portable export omits soft-deleted episodes, which is the
 * ordinary way an occurrence ends up naming one the file does not carry.
 *
 * The sixteenth, `cycleCiphertext`, is not a reference at all. It names a
 * sealed cycle value (a day-log note, the sensitive-category envelope, a
 * custom symptom's label) the file carried as ciphertext this host's keys do
 * not open — a portable file written before v1.40 on a host with another key.
 * Writing it back would store a value no reader can open, so the FIELD is kept
 * out and the day or the symptom restores without it. Its key is the path in
 * the file (`cycleDayLogs.<date>.notesEncrypted`), never the value.
 *
 * The seventeenth, `moodLabelCiphertext`, is the same for the label of a mood
 * tag or mood category the account created
 * (`customMoodTags.<key>.labelEncrypted`): the tag or category restores, under
 * its key, without the person's own name for it.
 *
 * The eighteenth and nineteenth, `visitCiphertext` and `vaccinationCiphertext`,
 * are the same again for the free text of the visits record (a practitioner's
 * note, address and phone; a visit's reason, outcome and body site) and of a
 * vaccination's note (`vaccinations.<id>.noteEncrypted`). The row restores
 * without the field.
 */
export type SkippedCatalogue =
  | "cycleSymptom"
  | "illnessSymptom"
  | "moodFactor"
  | "moodTag"
  | "visitReference"
  | "vaccinationReference"
  | "reminderReference"
  | "coachAttachment"
  | "coachReference"
  | "documentConditionLink"
  | "extractedFact"
  | "factCommitment"
  | "personalRecordReference"
  | "ecgReference"
  | "medicationTarget"
  | "scheduleRevisionLink"
  | "checkupClosure"
  | "accountSetting"
  | "symptomEpisodeReference"
  | "cycleCiphertext"
  | "moodLabelCiphertext"
  | "visitCiphertext"
  | "vaccinationCiphertext";

/** One key this instance does not know, and the links it cost. */
export interface SkippedCatalogueKey {
  catalogue: SkippedCatalogue;
  /** The key exactly as the file wrote it. Reported verbatim so an operator
   *  can grep the file for it and see which days it was on. */
  key: string;
  /** How many links referenced it — twelve day-logs is twelve, not one. */
  links: number;
}

/** Mutable accumulator threaded through one restore transaction. */
export type RestoreSkipLog = SkippedCatalogueKey[];

/** The report shape carried by the response, the audit row, and the UI. */
export interface RestoreSkipSummary {
  /** Distinct unknown keys, ordered by catalogue then key. */
  catalogueKeys: SkippedCatalogueKey[];
  /** Total links dropped across every catalogue. Zero means nothing was lost. */
  links: number;
}

/**
 * Record the keys a catalogue lookup could not resolve.
 *
 * `referenced` is the FLAT list of keys the file used, one entry per link, not
 * the deduplicated set the lookup queried with. A key that appears on twelve
 * day-logs cost twelve links, and reporting it as one would understate the loss
 * by a factor of twelve — which is the quiet-drop failure again, wearing a
 * number.
 */
export function recordUnknownKeys(
  log: RestoreSkipLog,
  catalogue: SkippedCatalogue,
  unresolved: readonly string[],
  referenced: readonly string[],
): void {
  for (const key of unresolved) {
    log.push({
      catalogue,
      key,
      links: referenced.filter((candidate) => candidate === key).length,
    });
  }
}

/** Fold the accumulator into the report the callers surface. */
export function summarizeRestoreSkips(log: RestoreSkipLog): RestoreSkipSummary {
  const catalogueKeys = [...log].sort((a, b) =>
    a.catalogue === b.catalogue
      ? a.key.localeCompare(b.key)
      : a.catalogue.localeCompare(b.catalogue),
  );
  return {
    catalogueKeys,
    links: catalogueKeys.reduce((total, entry) => total + entry.links, 0),
  };
}

/**
 * A section the file's own manifest says it carries, and does not.
 *
 * This is the other half of the honesty contract above, and it is deliberately
 * the opposite answer. A skip drops one edge and names it, because the record
 * it hangs off survives and giving the operator the rest is worth more than
 * refusing them everything. A missing SECTION is not one edge — it is a whole
 * class of the account, and the restore's first act is to delete the class it
 * is about to rebuild. Restoring a file whose documents section is not there
 * therefore does not lose a link. It empties the vault, tells the operator the
 * restore succeeded, and leaves them to find out later.
 *
 * So this one refuses the file. Nothing is deleted, and the response names the
 * section rather than saying "invalid backup", because an operator holding the
 * only copy of an account needs to know whether the file is worthless or
 * whether they picked the wrong one of two.
 *
 * ── The manifest is what tells a missing section from an omitted one ────────
 *
 * A payload that omits a section on purpose is not broken, and refusing it
 * would break the two exports that do it. `buildSensitiveBackupSection` leaves
 * the screener administrations and the consent receipts out of a PORTABLE file
 * — the first because the encrypted per-item answers include the PHQ-9
 * self-harm item, the second because a consent belongs to the operator it was
 * given to — and says so in the manifest as `included: "omitted"`. That is a
 * declared omission, and it stays restorable.
 *
 * The discriminator is therefore the manifest and nothing else. Not the emptiness
 * of the array: an account with no documents honestly writes `[]`, and treating
 * that as a loss would refuse a perfectly good file. Not the export's purpose
 * either, which the payload does not state. Only "the file said it carries this,
 * and the key is not there".
 *
 * A file with NO manifest at all declares nothing, so nothing is missing from
 * it. Every backup written before the manifest existed is in that category and
 * has to stay restorable.
 */
export type MissingBackupSection =
  "documents" | "workouts" | "mentalHealth" | "consent";

/**
 * Which payload key each manifest entry speaks for.
 *
 * `included: "omitted"` is the one value that means "not carried". Every other
 * value the writers produce — `metadata-only`, `encrypted-content`,
 * `summary-only`, `full` — describes HOW MUCH of the section travels, not
 * whether the section is there, and all of them come with the key present.
 */
const MANIFEST_SECTIONS: ReadonlyArray<{
  manifestKey: MissingBackupSection;
  payloadKey: string;
}> = [
  { manifestKey: "documents", payloadKey: "documents" },
  { manifestKey: "workouts", payloadKey: "workouts" },
  { manifestKey: "mentalHealth", payloadKey: "mentalHealthAssessments" },
  { manifestKey: "consent", payloadKey: "consentReceipts" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sections the raw file claims and does not carry, in manifest order.
 *
 * Takes the RAW parsed JSON, not a `BackupPayload`. Every section key in
 * `backupPayloadSchema` carries `.default([])`, so by the time the payload has
 * been through the schema an absent section and an empty one are the same
 * value — which is exactly the distinction this function exists to make. Run it
 * on the object that came out of `JSON.parse`.
 */
export function findMissingBackupSections(
  raw: unknown,
): MissingBackupSection[] {
  if (!isRecord(raw)) return [];
  const manifest = raw.manifest;
  if (!isRecord(manifest)) return [];

  const missing: MissingBackupSection[] = [];
  for (const { manifestKey, payloadKey } of MANIFEST_SECTIONS) {
    const entry = manifest[manifestKey];
    if (!isRecord(entry)) continue;
    if (entry.included === "omitted") continue;
    if (raw[payloadKey] === undefined) missing.push(manifestKey);
  }
  return missing;
}
