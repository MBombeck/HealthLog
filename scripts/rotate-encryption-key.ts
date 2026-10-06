/**
 * scripts/rotate-encryption-key.ts <new-key-id>
 *
 * Re-encrypts every encrypted column in the database with the currently
 * active key (`ENCRYPTION_ACTIVE_KEY_ID`). Idempotent: rows whose ciphertext
 * already carries the active key id prefix are skipped.
 *
 * The set of columns this script rotates is the canonical registry in
 * `src/lib/crypto/encrypted-columns.ts`. Two guard tests keep it honest:
 * `encrypted-columns.test.ts` fails CI if a `*Encrypted`-named schema column
 * is missing from the registry or is not referenced here, and
 * `encrypted-column-writers.test.ts` derives the ciphertext-bearing columns
 * from the Prisma write payloads instead of from names — the check that would
 * have caught `DataBackup.data`, ciphertext under a column called `data`.
 *
 * The run ends by naming every registered column it did NOT walk and exiting
 * non-zero, because an operator reads a zero here as permission to drop the
 * previous key, and "nothing left" and "never looked" must not print alike.
 *
 * After a complete, error-free run it checks every other configured key id
 * for remaining values and removes the boot key check's record (canary) of
 * each id that holds none, naming the columns of each id that still does.
 *
 * Usage:
 *   ENCRYPTION_KEYS='{"v1":"<old>","v2":"<new>"}' \
 *   ENCRYPTION_ACTIVE_KEY_ID=v2 \
 *   pnpm tsx scripts/rotate-encryption-key.ts v2
 */
import "dotenv/config";
import { Buffer } from "node:buffer";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt, extractKeyId, getActiveKeyId } from "@/lib/crypto";
import { retireCanariesWithoutData } from "@/lib/crypto/canary";
import {
  rotateColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnKey,
  preserveUpdatedAt,
  UPDATED_AT_MODELS,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";
import { tokeniseAndHash } from "@/lib/documents/content-index";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const targetKeyId = process.argv[2] ?? getActiveKeyId();
if (targetKeyId !== getActiveKeyId()) {
  console.error(
    `Refusing to rotate: argv key id '${targetKeyId}' does not match the ` +
      `currently active id '${getActiveKeyId()}'. Set ENCRYPTION_ACTIVE_KEY_ID first.`,
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

interface RotationResult {
  table: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
  /** Unreadable rows deleted from a `disposable` column (cache entries only). */
  dropped: number;
}

/**
 * Look a column up in the canonical registry so the walk honours the flags
 * recorded there (`batched`, `disposable`, `codecField`) rather than a second
 * hand-written copy of them here.
 */
function registryColumn(model: string, field: string): EncryptedColumn {
  const col = ENCRYPTED_COLUMNS.find(
    (c) => c.model === model && c.field === field,
  );
  if (!col) {
    throw new Error(
      `${model}.${field} is not in the encrypted-column registry`,
    );
  }
  return col;
}

/** Rotate one column through the shared registry-driven corpus walk. */
async function rotateRegistryColumn(
  model: string,
  field: string,
  client: CorpusClient,
): Promise<RotationResult> {
  const r = await rotateColumn(client, registryColumn(model, field));
  return {
    table: r.model,
    field: r.field,
    scanned: r.scanned,
    rotated: r.rotated,
    errors: r.errors,
    dropped: r.dropped,
  };
}

/** True for a Prisma "record to update not found" (P2025). */
function isRowGone(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2025"
  );
}

function shouldRotate(value: string | null): boolean {
  if (!value) return false;
  const id = extractKeyId(value);
  // null = legacy/unversioned (rotate); else rotate if not already on active.
  return id !== getActiveKeyId();
}

/** The part of a Prisma delegate the per-column walks below need. */
interface PagedDelegate<V> {
  findMany: (args: {
    select: Record<string, true>;
    orderBy: { id: "asc" };
    take: number;
    where?: { id: { gt: string } };
  }) => Promise<Array<Record<string, unknown>>>;
  update: (args: {
    where: { id: string; updatedAt?: Date };
    data: Record<string, V | Date>;
  }) => Promise<unknown>;
}

/** Rows per page when walking a column. */
const PAGE_SIZE = 5_000;

/**
 * Every row of one column, `id` and value only, a page at a time in id order.
 * The walks used to read a column in one `findMany`, which for
 * `Measurement.notesEncrypted` is every measurement of the instance: 1.25
 * million rows on one large account (#1031).
 */
async function* pagedRows(
  delegate: PagedDelegate<unknown>,
  field: string,
  table: string,
): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | null = null;
  for (;;) {
    const rows = await delegate.findMany({
      select: {
        id: true,
        [field]: true,
        ...(UPDATED_AT_MODELS.has(table) ? { updatedAt: true } : {}),
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      // `id > last`, not Prisma's `cursor` + `skip`: the cursor form looks
      // the last row up again, and a row deleted between pages ends the walk.
      ...(cursor ? { where: { id: { gt: cursor } } } : {}),
    });
    if (rows.length === 0) return;
    yield* rows;
    if (rows.length < PAGE_SIZE) return;
    cursor = rows[rows.length - 1]!.id as string;
  }
}

/**
 * Rotate one `String` ciphertext column on a Prisma model. `delegate` is the
 * `prisma.<model>` accessor; `field` is the column. Reads only `id` + the
 * column, re-encrypts every row not already on the active key.
 */
async function rotateStringColumn(
  table: string,
  field: string,
  delegate: PagedDelegate<string>,
): Promise<RotationResult> {
  const result: RotationResult = {
    table,
    field,
    scanned: 0,
    rotated: 0,
    errors: 0,
    dropped: 0,
  };
  for await (const row of pagedRows(
    delegate as PagedDelegate<unknown>,
    field,
    table,
  )) {
    const v = row[field] as string | null;
    // `scanned` counts rows that hold ciphertext, as the in-app rotation does.
    if (!v) continue;
    result.scanned++;
    if (!shouldRotate(v)) continue;
    const id = row.id as string;
    try {
      const re = encrypt(decrypt(v));
      // Re-sealing is not an edit: the row keeps its own updatedAt.
      const keepUpdatedAt = preserveUpdatedAt(table, row.updatedAt);
      await delegate.update({
        where: { id, ...keepUpdatedAt },
        data: { [field]: re, ...keepUpdatedAt },
      });
      result.rotated++;
    } catch (err) {
      // Edited or deleted since the read: the next run picks it up.
      if (isRowGone(err)) continue;
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Rotate one `Bytes` ciphertext column. The encrypt/decrypt helpers operate
 * on strings, so we go through a UTF-8 Buffer round-trip identical to the
 * persistence layer (`src/lib/ai/coach/persistence.ts:60-71`).
 */
async function rotateBytesColumn(
  table: string,
  field: string,
  delegate: PagedDelegate<Uint8Array>,
): Promise<RotationResult> {
  const result: RotationResult = {
    table,
    field,
    scanned: 0,
    rotated: 0,
    errors: 0,
    dropped: 0,
  };
  for await (const row of pagedRows(
    delegate as PagedDelegate<unknown>,
    field,
    table,
  )) {
    const buf = row[field] as Uint8Array | null;
    if (!buf || buf.byteLength === 0) continue;
    result.scanned++;
    const asString = Buffer.from(buf).toString("utf8");
    if (!shouldRotate(asString)) continue;
    const id = row.id as string;
    try {
      const rotated = encrypt(decrypt(asString));
      const encoded = Buffer.from(rotated, "utf8");
      const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      next.set(encoded);
      const keepUpdatedAt = preserveUpdatedAt(table, row.updatedAt);
      await delegate.update({
        where: { id, ...keepUpdatedAt },
        data: { [field]: next, ...keepUpdatedAt },
      });
      result.rotated++;
    } catch (err) {
      if (isRowGone(err)) continue;
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

async function main() {
  console.log(`Rotating encrypted rows to active key id: ${targetKeyId}`);
  const results: RotationResult[] = [];

  // ───── User — integration credentials + AI keys + KVNR (String) ─────
  // Columns: "codexAccessTokenEncrypted" "codexRefreshTokenEncrypted"
  // "telegramBotToken" "withingsClientIdEncrypted"
  // "withingsClientSecretEncrypted" "whoopClientIdEncrypted"
  // "whoopClientSecretEncrypted" "fitbitClientIdEncrypted"
  // "fitbitClientSecretEncrypted" "nightscoutUrlEncrypted"
  // "nightscoutTokenEncrypted" "polarAccessTokenEncrypted"
  // "polarUserIdEncrypted" "polarClientIdEncrypted"
  // "polarClientSecretEncrypted" "ouraAccessTokenEncrypted"
  // "ouraRefreshTokenEncrypted" "ouraClientIdEncrypted"
  // "ouraClientSecretEncrypted" "stravaClientIdEncrypted"
  // "stravaClientSecretEncrypted" "stravaAccessTokenEncrypted"
  // "stravaRefreshTokenEncrypted" "aiAnthropicKeyEncrypted"
  // "aiLocalKeyEncrypted" "aiOpenaiKeyEncrypted" "insuranceNumberEncrypted"
  // v1.33.1 adds the gateway bearer; it is named in the array below only.
  // Quoting a column name in this comment would satisfy the coverage guard
  // in encrypted-columns.test.ts without the script rotating anything, so
  // the newest entry stays unquoted here on purpose.
  const userFields = [
    "codexAccessTokenEncrypted",
    "codexRefreshTokenEncrypted",
    "telegramBotToken",
    "withingsClientIdEncrypted",
    "withingsClientSecretEncrypted",
    "whoopClientIdEncrypted",
    "whoopClientSecretEncrypted",
    "fitbitClientIdEncrypted",
    "fitbitClientSecretEncrypted",
    "googleHealthClientIdEncrypted",
    "googleHealthClientSecretEncrypted",
    "nightscoutUrlEncrypted",
    "nightscoutTokenEncrypted",
    "polarAccessTokenEncrypted",
    "polarUserIdEncrypted",
    "polarClientIdEncrypted",
    "polarClientSecretEncrypted",
    "ouraAccessTokenEncrypted",
    "ouraRefreshTokenEncrypted",
    "ouraClientIdEncrypted",
    "ouraClientSecretEncrypted",
    "stravaClientIdEncrypted",
    "stravaClientSecretEncrypted",
    "stravaAccessTokenEncrypted",
    "stravaRefreshTokenEncrypted",
    "aiAnthropicKeyEncrypted",
    "aiLocalKeyEncrypted",
    "aiOpenaiKeyEncrypted",
    // v1.33.1 (#470) — the OpenAI-compatible gateway's optional bearer.
    "aiCompatKeyEncrypted",
    "insuranceNumberEncrypted",
    // v1.23 — TOTP shared secret (second factor).
    "totpSecretEncrypted",
  ];
  for (const field of userFields) {
    results.push(await rotateStringColumn("User", field, prisma.user));
  }

  // ───── OAuth token tables (String "accessToken" / "refreshToken") ─────
  for (const field of ["accessToken", "refreshToken"]) {
    results.push(
      await rotateStringColumn(
        "WithingsConnection",
        field,
        prisma.withingsConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "WhoopConnection",
        field,
        prisma.whoopConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "FitbitConnection",
        field,
        prisma.fitbitConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "GoogleHealthConnection",
        field,
        prisma.googleHealthConnection,
      ),
    );
  }

  // ───── Document picker (String) ─────
  // Column: "tokenEncrypted" — a person's Paperless-ngx / Papra API token.
  results.push(
    await rotateStringColumn(
      "DocumentSourceConnection",
      "tokenEncrypted",
      prisma.documentSourceConnection,
    ),
  );

  // ───── AppSettings — operator credentials (String) ─────
  // Columns: "adminAiKeyEncrypted" "webPushVapidPrivateKeyEncrypted"
  // "adminCodexAccessTokenEncrypted" "adminCodexRefreshTokenEncrypted"
  // "adminCodexAccountIdEncrypted"
  for (const field of [
    "adminAiKeyEncrypted",
    "webPushVapidPrivateKeyEncrypted",
    "adminCodexAccessTokenEncrypted",
    "adminCodexRefreshTokenEncrypted",
    "adminCodexAccountIdEncrypted",
  ]) {
    results.push(
      await rotateStringColumn("AppSettings", field, prisma.appSettings),
    );
  }

  // ───── Custom labels — mood + cycle (String "labelEncrypted") ─────
  // Catalogue rows carry NULL and are skipped by `shouldRotate`.
  results.push(
    await rotateStringColumn("MoodTag", "labelEncrypted", prisma.moodTag),
  );
  results.push(
    await rotateStringColumn(
      "MoodTagCategory",
      "labelEncrypted",
      prisma.moodTagCategory,
    ),
  );
  results.push(
    await rotateStringColumn(
      "CycleSymptom",
      "labelEncrypted",
      prisma.cycleSymptom,
    ),
  );
  // v1.40 (#1041) — custom medication categories. A Bytes column, unlike the
  // three String label columns above.
  results.push(
    await rotateBytesColumn(
      "MedicationCategoryLabel",
      "labelEncrypted",
      prisma.medicationCategoryLabel,
    ),
  );

  // ───── NotificationChannel."config" (encrypted JSON) ─────
  // Channel config (Telegram chat id, ntfy topic, etc.). Skipping these on
  // rotation would leave channels permanently undecryptable once the
  // operator drops `v1` from the key map.
  results.push(
    await rotateStringColumn(
      "NotificationChannel",
      "config",
      prisma.notificationChannel,
    ),
  );

  // ───── PushSubscription."p256dh" / "auth" ─────
  // Web-push routing secrets — without these, the push endpoint is reachable
  // but the browser ignores the message (auth tag mismatch).
  for (const field of ["p256dh", "auth"]) {
    results.push(
      await rotateStringColumn(
        "PushSubscription",
        field,
        prisma.pushSubscription,
      ),
    );
  }

  // ───── IntegrationStatus."lastError" ─────
  // AES-256-GCM ciphertext of an upstream error payload. Drop the legacy key
  // while a row still lives here and the admin status view 500s.
  results.push(
    await rotateStringColumn(
      "IntegrationStatus",
      "lastError",
      prisma.integrationStatus,
    ),
  );

  // ───── CycleDayLog — "sensitiveEncrypted" / "notesEncrypted" (String) ─────
  for (const field of ["sensitiveEncrypted", "notesEncrypted"]) {
    results.push(
      await rotateStringColumn("CycleDayLog", field, prisma.cycleDayLog),
    );
  }

  // ───── Coach (Bytes columns) ─────
  // "encryptedContent" "resultsEncrypted" "trailEncrypted" "summaryEncrypted"
  // "titleEncrypted" "factEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachMessage",
      "encryptedContent",
      prisma.coachMessage,
    ),
  );
  // v1.39.4 — the tables of values a turn read. NULL on every turn without a
  // table, which `rotateBytesColumn` skips.
  results.push(
    await rotateBytesColumn(
      "CoachMessage",
      "resultsEncrypted",
      prisma.coachMessage,
    ),
  );
  // v1.41 — the model text of the turn's trail. NULL on every turn without
  // one, which `rotateBytesColumn` skips.
  results.push(
    await rotateBytesColumn(
      "CoachMessage",
      "trailEncrypted",
      prisma.coachMessage,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "CoachConversation",
      "summaryEncrypted",
      prisma.coachConversation,
    ),
  );
  // v1.39.3 — the conversation title. NULL on a row the free-text backfill
  // has not reached yet (its title is still in the readable column), which
  // `rotateBytesColumn` skips.
  results.push(
    await rotateBytesColumn(
      "CoachConversation",
      "titleEncrypted",
      prisma.coachConversation,
    ),
  );
  results.push(
    await rotateBytesColumn("CoachFact", "factEncrypted", prisma.coachFact),
  );

  // ───── CoachPlan (Bytes columns) ─────
  // "ifCueEncrypted" "thenActionEncrypted" "targetEncrypted" "outcomeEncrypted"
  for (const field of [
    "ifCueEncrypted",
    "thenActionEncrypted",
    "targetEncrypted",
    "outcomeEncrypted",
  ]) {
    results.push(await rotateBytesColumn("CoachPlan", field, prisma.coachPlan));
  }

  // ───── CoachReminder (Bytes column) ─────
  // "noteEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachReminder",
      "noteEncrypted",
      prisma.coachReminder,
    ),
  );

  // ───── UserHealthProfile (Bytes columns) ─────
  // "aboutMeEncrypted" "conditionsEncrypted" "allergiesEncrypted"
  // "coachFocusEncrypted" "pendingQuestionsEncrypted"
  // "emergencyContactsEncrypted" "emergencyImplantsEncrypted"
  // "emergencyNoteEncrypted"
  for (const field of [
    "aboutMeEncrypted",
    "conditionsEncrypted",
    "allergiesEncrypted",
    "coachFocusEncrypted",
    "pendingQuestionsEncrypted",
    "emergencyContactsEncrypted",
    "emergencyImplantsEncrypted",
    "emergencyNoteEncrypted",
  ]) {
    results.push(
      await rotateBytesColumn(
        "UserHealthProfile",
        field,
        prisma.userHealthProfile,
      ),
    );
  }

  // ───── HealthProfileFactRevision."valueEncrypted" (Bytes) ─────
  results.push(
    await rotateBytesColumn(
      "HealthProfileFactRevision",
      "valueEncrypted",
      prisma.healthProfileFactRevision,
    ),
  );

  // ───── InsightNarrative."encryptedContent" (Bytes) ─────
  results.push(
    await rotateBytesColumn(
      "InsightNarrative",
      "encryptedContent",
      prisma.insightNarrative,
    ),
  );

  // ───── v1.39.0 InsightStatusCache."textEncrypted" / "itemsEncrypted" ─────
  // The per-metric status notes. Both nullable (a row may carry only a
  // negative-cache window; only one card stores per-item lines), and
  // `rotateBytesColumn` skips a NULL payload.
  results.push(
    await rotateBytesColumn(
      "InsightStatusCache",
      "textEncrypted",
      prisma.insightStatusCache,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "InsightStatusCache",
      "itemsEncrypted",
      prisma.insightStatusCache,
    ),
  );

  // ───── v1.31.0 ArrivalReaction."lineEncrypted" (Bytes, nullable) ─────
  // The data-arrival spine's generated reaction line. Nullable by design — a
  // provider-less install writes markers with no line at all — and
  // `rotateBytesColumn` already skips a NULL / zero-length payload, so those
  // rows are scanned and cleanly left alone.
  results.push(
    await rotateBytesColumn(
      "ArrivalReaction",
      "lineEncrypted",
      prisma.arrivalReaction,
    ),
  );

  // ───── v1.31.0 WorkoutInsight."paragraphEncrypted" (Bytes) ─────
  // The per-workout Activity Insight paragraph. Not nullable — a row exists
  // only where a paragraph was generated — so every scanned row rotates.
  results.push(
    await rotateBytesColumn(
      "WorkoutInsight",
      "paragraphEncrypted",
      prisma.workoutInsight,
    ),
  );

  // ───── v1.18.1 clinical-spine notes (Bytes columns) ─────
  // "noteEncrypted" (LabResult / IllnessEpisode / IllnessDayLog) +
  // "contextEncrypted" (Biomarker). Mirror the CoachFact.factEncrypted block.
  results.push(
    await rotateBytesColumn("LabResult", "noteEncrypted", prisma.labResult),
  );
  results.push(
    await rotateBytesColumn("Biomarker", "contextEncrypted", prisma.biomarker),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessEpisode",
      "noteEncrypted",
      prisma.illnessEpisode,
    ),
  );
  // v1.39.2 — a condition's body site.
  results.push(
    await rotateBytesColumn(
      "IllnessEpisode",
      "bodySiteEncrypted",
      prisma.illnessEpisode,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessDayLog",
      "noteEncrypted",
      prisma.illnessDayLog,
    ),
  );
  // v1.40 — person-defined symptoms: the name and the per-occurrence note.
  results.push(
    await rotateBytesColumn(
      "SymptomDefinition",
      "labelEncrypted",
      prisma.symptomDefinition,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "SymptomEvent",
      "noteEncrypted",
      prisma.symptomEvent,
    ),
  );

  // ───── v1.19.0 ECG waveform (Bytes column) ─────
  // "waveformEncrypted" holds the JSON-encoded micro-volt sample array in the
  // same `encrypt()` ciphertext-string-as-UTF-8 shape the Coach columns use
  // (see src/lib/withings/ecg-waveform-codec.ts), so the generic Bytes
  // rotation re-stamps it without decoding the waveform.
  results.push(
    await rotateBytesColumn(
      "EcgRecording",
      "waveformEncrypted",
      prisma.ecgRecording,
    ),
  );

  // ───── v1.23 free-text health notes (Bytes columns) ─────
  // "noteEncrypted" (MoodEntry) + "notesEncrypted" (Measurement). Same shared-
  // codec shape as the clinical-spine note columns. NULL on rows whose note is
  // still in the legacy plaintext column (pre-backfill) — `rotateBytesColumn`
  // skips those.
  results.push(
    await rotateBytesColumn("MoodEntry", "noteEncrypted", prisma.moodEntry),
  );
  results.push(
    await rotateBytesColumn(
      "Measurement",
      "notesEncrypted",
      prisma.measurement,
    ),
  );
  // v1.38 — the day-context note on a mood entry. Its own table, so its own
  // walk; a context row exists only where somebody added one, and a row with
  // no note carries NULL here and is skipped like every other nullable Bytes
  // column. It goes through the registry-driven walk rather than the generic
  // `id`-keyed one above: the table is keyed on `moodEntryId`, and selecting a
  // column Prisma does not know threw mid-pass and abandoned every column
  // after it — a rotation that reported nothing at all rather than a gap.
  results.push(
    await rotateRegistryColumn("MoodContext", "notesEncrypted", {
      moodContext: prisma.moodContext,
    } as unknown as CorpusClient),
  );

  // ───── v1.25 medication free-text notes (Bytes columns) ─────
  // "notesEncrypted" (MedicationSideEffect + MedicationInventoryItem) +
  // "noteEncrypted" (MedicationDoseChange). Same shared-codec shape as the
  // other free-text note columns. NULL on rows whose note is still in the
  // legacy plaintext column (pre-backfill) — `rotateBytesColumn` skips those.
  results.push(
    await rotateBytesColumn(
      "MedicationSideEffect",
      "notesEncrypted",
      prisma.medicationSideEffect,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "MedicationDoseChange",
      "noteEncrypted",
      prisma.medicationDoseChange,
    ),
  );
  // v1.40 (#1024) — the note on a medication course.
  results.push(
    await rotateBytesColumn(
      "MedicationCourse",
      "noteEncrypted",
      prisma.medicationCourse,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "MedicationInventoryItem",
      "notesEncrypted",
      prisma.medicationInventoryItem,
    ),
  );

  // ───── v1.25 mental-health screener item answers (Bytes column) ─────
  // The PHQ-9 / GAD-7 encrypted per-item blob. Always present (NOT NULL), so
  // every row rotates.
  results.push(
    await rotateBytesColumn(
      "MentalHealthAssessment",
      "responsesEncrypted",
      prisma.mentalHealthAssessment,
    ),
  );
  // ───── v1.25 structured health records (Bytes columns) ─────
  // Allergy free-text reaction + note; family-history note. Always encrypted
  // on write (no legacy plaintext column), so every non-null row rotates.
  results.push(
    await rotateBytesColumn("Allergy", "reactionEncrypted", prisma.allergy),
  );
  results.push(
    await rotateBytesColumn("Allergy", "notesEncrypted", prisma.allergy),
  );
  results.push(
    await rotateBytesColumn(
      "FamilyHistoryEntry",
      "notesEncrypted",
      prisma.familyHistoryEntry,
    ),
  );

  // ───── v1.38.0 visit free text (Bytes columns) ─────
  // Why the person went, what came out of it, and the practice note. Always
  // encrypted on write, so every non-null row rotates.
  results.push(
    await rotateBytesColumn("Encounter", "reasonEncrypted", prisma.encounter),
  );
  results.push(
    await rotateBytesColumn("Encounter", "outcomeEncrypted", prisma.encounter),
  );
  // v1.39.1 — a procedure's body site.
  results.push(
    await rotateBytesColumn("Encounter", "bodySiteEncrypted", prisma.encounter),
  );
  results.push(
    await rotateBytesColumn(
      "Practitioner",
      "noteEncrypted",
      prisma.practitioner,
    ),
  );
  // v1.39.4 — the practice's phone number and address. NULL on a field the
  // person left empty and on a row the free-text backfill has not reached
  // yet; `rotateBytesColumn` skips both.
  results.push(
    await rotateBytesColumn(
      "Practitioner",
      "phoneEncrypted",
      prisma.practitioner,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "Practitioner",
      "locationEncrypted",
      prisma.practitioner,
    ),
  );

  // ───── v1.39.4 workout GPS track (Bytes, binary2, batched) ─────
  // One sealed binary value per route, labelled for its purpose. Walked
  // through the registry so the binary codec and the label are honoured, in
  // id-cursor batches because a track can be close to a megabyte. NULL on a
  // row the free-text backfill has not reached yet, which the walk skips.
  results.push(
    await rotateRegistryColumn("WorkoutRoute", "geometryEncrypted", {
      workoutRoute: prisma.workoutRoute,
    } as unknown as CorpusClient),
  );

  // ───── v1.39.3 custom-metric reading note (Bytes column) ─────
  // NULL on a reading without a note, and on a row the free-text backfill has
  // not reached yet; `rotateBytesColumn` skips both.
  results.push(
    await rotateBytesColumn(
      "CustomMetricEntry",
      "noteEncrypted",
      prisma.customMetricEntry,
    ),
  );

  // ───── v1.38.0 dose free text (Bytes column) ─────
  // The note on an administered dose — a reaction, a sore arm. Always
  // encrypted on write, so every non-null row rotates.
  results.push(
    await rotateBytesColumn(
      "VaccinationRecord",
      "noteEncrypted",
      prisma.vaccinationRecord,
    ),
  );

  // ───── Inbound clinical document (Bytes column, codec-dispatched) ─────
  // The raw uploaded document. Two layouts recorded per row in
  // `contentCodec` ("base64v1" string codec | "binary2" binary codec), so
  // rotation goes through the shared codec-aware corpus walk: bounded
  // id-cursor batches (rows are up to cap-sized blobs — never an unbounded
  // findMany) re-encrypted under each row's OWN codec. Idempotent, so an
  // interrupted run resumes on re-invocation.
  {
    const docResult = await rotateColumn(
      { inboundDocument: prisma.inboundDocument } as unknown as CorpusClient,
      {
        model: "InboundDocument",
        field: "contentEncrypted",
        kind: "bytes",
        codecField: "contentCodec",
      },
    );
    results.push({
      table: docResult.model,
      field: docResult.field,
      scanned: docResult.scanned,
      rotated: docResult.rotated,
      errors: docResult.errors,
      dropped: docResult.dropped,
    });
  }
  // The staged extracted-fact payloads: the FHIR-staged clinical values and the
  // verbatim source-span provenance. Both NOT NULL, so every staged row rotates.
  results.push(
    await rotateBytesColumn(
      "ExtractedFact",
      "dataEncrypted",
      prisma.extractedFact,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "ExtractedFact",
      "provenanceEncrypted",
      prisma.extractedFact,
    ),
  );
  // The short background document summary. Small `encrypt()`-string-as-UTF-8
  // Bytes payload (never the multi-megabyte original blob — the select is
  // scoped to id + this column), so the generic Bytes walk covers it. NULL on
  // rows uploaded with auto-read OFF / no provider — `rotateBytesColumn` skips
  // those.
  results.push(
    await rotateBytesColumn(
      "InboundDocument",
      "summaryEncrypted",
      prisma.inboundDocument,
    ),
  );

  // ───── v1.27.22 document content-search index (Bytes text + re-tokenise) ─────
  // The blind content index carries TWO coupled artefacts under the index key
  // story: `text_encrypted` (the `encrypt()`-string-as-UTF-8 Bytes shape) AND
  // `search_tokens` (HMAC-SHA256 under an HKDF subkey derived from the ACTIVE
  // key). Rotating the master key changes that subkey, so a plain Bytes rotation
  // of the text alone would leave the tokens hashed under the OLD subkey and
  // search would silently miss the row. This dedicated block re-encrypts the
  // text AND re-tokenises from the decrypted plaintext under the NEW subkey in
  // the same update (P2-D7). Bounded id-cursor batches — the text is capped but
  // still a blob, so an unbounded findMany is avoided. Idempotent: rows already
  // on the active key are skipped, so an interrupted run resumes safely.
  {
    const result: RotationResult = {
      table: "DocumentContentIndex",
      field: "textEncrypted",
      scanned: 0,
      rotated: 0,
      errors: 0,
      dropped: 0,
    };
    // The verbatim sibling rides the same update, but it needs its own line in
    // the summary: the coverage check reads the results to decide which
    // registered columns this run actually looked at, and a column that
    // rotates without ever being named there reads as skipped.
    const verbatim: RotationResult = {
      table: "DocumentContentIndex",
      field: "verbatimTextEncrypted",
      scanned: 0,
      rotated: 0,
      errors: 0,
      dropped: 0,
    };
    let cursor: string | null = null;
    // v1.27.33 (Document vault P4) — re-encrypt the string-shaped BYTEA into a
    // fresh Uint8Array under the active key. Shared by `textEncrypted` and the
    // nullable sibling `verbatimTextEncrypted` (same codec).
    const reEncryptBytes = (asString: string): Uint8Array => {
      const reEnc = encrypt(decrypt(asString));
      const encoded = Buffer.from(reEnc, "utf8");
      const nextBytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      nextBytes.set(encoded);
      return nextBytes;
    };
    for (;;) {
      const rows = await prisma.documentContentIndex.findMany({
        select: {
          id: true,
          textEncrypted: true,
          verbatimTextEncrypted: true,
          updatedAt: true,
        },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { where: { id: { gt: cursor } } } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        result.scanned++;
        const buf = row.textEncrypted as Uint8Array | null;
        if (!buf || buf.byteLength === 0) continue;
        const asString = Buffer.from(buf).toString("utf8");
        if (!shouldRotate(asString)) continue;
        // The "verbatimTextEncrypted" column (nullable; written together with
        // "textEncrypted" so it shares the same key) rotates in the same
        // update when present. Read outside the try so the catch can count it.
        const verbatimBuf = row.verbatimTextEncrypted as Uint8Array | null;
        const hasVerbatim = Boolean(verbatimBuf && verbatimBuf.byteLength > 0);
        if (hasVerbatim) verbatim.scanned++;
        try {
          const plaintext = decrypt(asString);
          const nextBytes = reEncryptBytes(asString);
          const searchTokens = tokeniseAndHash(plaintext);
          const verbatimNext = hasVerbatim
            ? reEncryptBytes(Buffer.from(verbatimBuf!).toString("utf8"))
            : undefined;
          await prisma.documentContentIndex.update({
            // Re-sealing is not an edit: the row keeps its own updatedAt.
            where: { id: row.id, updatedAt: row.updatedAt },
            data: {
              updatedAt: row.updatedAt,
              textEncrypted: nextBytes,
              searchTokens,
              ...(verbatimNext ? { verbatimTextEncrypted: verbatimNext } : {}),
            },
          });
          result.rotated++;
          if (verbatimNext) verbatim.rotated++;
        } catch (err) {
          result.errors++;
          if (hasVerbatim) verbatim.errors++;
          console.error(
            `[DocumentContentIndex.textEncrypted] row ${row.id}: ${(err as Error).message}`,
          );
        }
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < 100) break;
    }
    results.push(result);
    results.push(verbatim);
  }

  // ───── Document preview thumbnails (Bytes column) ─────
  // The small JPEG preview, stored as the `encrypt()`-string-as-UTF-8 Bytes
  // shape (base64 of the JPEG) — the same codec as the content index — so the
  // shared Bytes walk re-encrypts it under the active key. NOT NULL, so every
  // thumbnail row rotates.
  results.push(
    await rotateBytesColumn(
      "DocumentThumbnail",
      "thumbnailEncrypted",
      prisma.documentThumbnail,
    ),
  );

  // ───── v1.40 background document AI runs (Bytes, binary2, batched) ─────
  // A run's sealed input and result. Transient (deleted an hour after the run
  // finishes), but a run in flight during a rotation must still open under the
  // new key. Walked through the registry so the binary codec, the labels and
  // the disposable rule are honoured; NULL once a run has finished (input) or
  // before it has (result), which the walk skips.
  for (const field of ["inputEncrypted", "resultEncrypted"] as const) {
    results.push(
      await rotateRegistryColumn("DocumentAiRun", field, {
        documentAiRun: prisma.documentAiRun,
      } as unknown as CorpusClient),
    );
  }

  // ───── Whole-account backup blob (String, batched) ─────
  // `DataBackup.data` holds `packBackupBlob()` output: AES-256-GCM ciphertext
  // under a column that does NOT carry the `*Encrypted` suffix, which is why
  // it sat outside rotation until v1.38.6. Missing it was the worst possible
  // miss — the script reported zero rows remaining, the runbook told the
  // operator that zero meant safe to drop the old key, and every stored backup
  // became undecryptable. From v1.39.2 the column holds only copies written
  // before pieces existed, in any of three envelopes (the plain backup JSON,
  // the `HLZ1:` gzip form, the `~hlgcm1.` stream of v1.38.6 to v1.39.1). Rotation does not
  // re-seal them in place, which would hold a whole copy several times over;
  // it converts each one into pieces under the active key, one row at a time
  // and a slice of the value at a time, so the walk needs the whole client
  // (it opens a transaction per row) rather than one delegate.
  results.push(
    await rotateRegistryColumn(
      "DataBackup",
      "data",
      prisma as unknown as CorpusClient,
    ),
  );

  // ───── Whole-account backup in pieces (Bytes, binary2, batched) ─────
  // From v1.39.2 a backup is stored as sealed pieces in "data_backup_chunks",
  // one `encryptBytes()` value each, and the "data" column above holds only
  // copies written before that. Walked in id-cursor batches of a few pieces
  // (each is about a megabyte) and re-sealed without reading the backup: the
  // header that ties a piece to its copy and position is inside the
  // ciphertext, so it comes through rotation unchanged.
  results.push(
    await rotateRegistryColumn("DataBackupChunk", "data", {
      dataBackupChunk: prisma.dataBackupChunk,
    } as unknown as CorpusClient),
  );

  // ───── Idempotent-replay response cache (String, disposable) ─────
  // `IdempotencyKey.responseBody` is the cached response body, encrypted
  // because the PHI-returning creates echo their own decrypted DTO. Rotating
  // it keeps a key drop from handing a replaying client a body it cannot
  // parse; a row that cannot be read is deleted rather than counted as an
  // error, because a cache miss only costs a re-run.
  results.push(
    await rotateRegistryColumn("IdempotencyKey", "responseBody", {
      idempotencyKey: prisma.idempotencyKey,
    } as unknown as CorpusClient),
  );

  console.log("\n=== Rotation summary ===");
  let totalRotated = 0;
  let totalErrors = 0;
  let totalDropped = 0;
  for (const r of results) {
    console.log(
      `${r.table}.${r.field}: scanned=${r.scanned} rotated=${r.rotated} ` +
        `errors=${r.errors} dropped=${r.dropped}`,
    );
    totalRotated += r.rotated;
    totalErrors += r.errors;
    totalDropped += r.dropped;
  }
  console.log(
    `\nTOTAL rotated=${totalRotated} errors=${totalErrors} dropped=${totalDropped}`,
  );

  // ───── Coverage: what was NOT looked at ─────
  // A zero that means "nothing left" and a zero that means "never looked" read
  // the same on the summary above, and the operator acts on that zero by
  // dropping the old key. So say which registered columns this run actually
  // walked, and refuse to report success if any of them was skipped.
  const walked = new Set(results.map((r) => `${r.table}.${r.field}`));
  const notWalked = ENCRYPTED_COLUMNS.filter(
    (c) => !walked.has(encryptedColumnKey(c)),
  ).map(encryptedColumnKey);
  console.log(
    `\nColumns walked: ${walked.size}/${ENCRYPTED_COLUMNS.length} registered`,
  );
  if (notWalked.length > 0) {
    console.error(
      `\nNOT WALKED (${notWalked.length}) — rotation is INCOMPLETE, do not ` +
        `drop the previous key:\n  ${notWalked.join("\n  ")}`,
    );
  }

  // ───── Key-check records of retired key ids ─────
  // The boot key check keeps one canary per configured key id. Once no
  // registered column holds a single value under an id, that id's key can
  // leave ENCRYPTION_KEYS, and its canary goes with it: left behind, it would
  // refuse a later, different key configured under the same id. Only after a
  // complete, error-free run; the existence check walks every column itself
  // rather than trusting the counts above.
  if (notWalked.length === 0 && totalErrors === 0) {
    const { removed, remaining } = await retireCanariesWithoutData(prisma);
    for (const [keyId, columns] of Object.entries(remaining)) {
      console.log(
        `\nKey id '${keyId}': values remain in ${columns.length} column(s); ` +
          `keep its key:\n  ${columns.join("\n  ")}`,
      );
    }
    for (const keyId of removed) {
      console.log(
        `\nKey id '${keyId}': no values remain. Its key-check record was ` +
          `removed; its key can now leave ENCRYPTION_KEYS.`,
      );
    }
  }

  await prisma.$disconnect();
  if (notWalked.length > 0) process.exit(4);
  process.exit(totalErrors > 0 ? 3 : 0);
}

main().catch(async (err) => {
  console.error("Rotation failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
