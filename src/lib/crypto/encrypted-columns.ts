/**
 * Canonical registry of every database column that holds AES-256-GCM
 * ciphertext (via `src/lib/crypto.ts`).
 *
 * This is the single source of truth for the key-rotation script
 * (`scripts/rotate-encryption-key.ts`): the script MUST re-encrypt every
 * column listed here, and the guard test
 * (`encrypted-columns.test.ts`) asserts three invariants:
 *
 *   1. Every encrypted column in `prisma/schema.prisma` (any `*Encrypted`
 *      column, plus the small set of historically-named encrypted columns
 *      enumerated below) appears in this registry.
 *   2. The rotation script references every column in this registry.
 *   3. No registry entry is missing a kind / duplicated.
 *
 * Adding a new encrypted column WITHOUT adding it here fails CI; adding it
 * here without wiring the rotation script also fails CI. Together this makes
 * "a new encrypted column silently skipped on rotation" structurally
 * impossible — dropping a legacy key would otherwise make those rows
 * permanently undecryptable (decrypt is fail-closed).
 *
 * `kind` distinguishes the storage shape the rotation script must use:
 *   - "string" — the ciphertext is stored as a `String` column; the script
 *     reads/writes the value directly.
 *   - "bytes"  — the ciphertext is stored as a `Bytes` column; the script
 *     goes through a UTF-8 Buffer round-trip (matching the persistence layer).
 *
 * The `*Encrypted` suffix is NOT what makes a column belong here. It is a
 * naming convention that happens to hold for most of them, and treating it as
 * the definition is how `DataBackup.data` — the whole-account backup blob —
 * went unregistered until v1.38.6: encrypted on write, invisible to
 * a registry keyed on names, and therefore reported as "zero rows remaining"
 * by a rotation that never looked at it. An operator following the runbook
 * would then have dropped the old key and lost every backup. The guard test
 * `encrypted-column-writers.test.ts` now derives the ciphertext-bearing set
 * from the Prisma write payloads instead, so a column earns its place here by
 * what the code stores in it, not by what it is called.
 */

export type EncryptedColumnKind = "string" | "bytes";

export interface EncryptedColumn {
  /** Prisma model name (PascalCase, as declared in schema.prisma). */
  readonly model: string;
  /** Prisma field name (camelCase, as declared in schema.prisma). */
  readonly field: string;
  readonly kind: EncryptedColumnKind;
  /**
   * Present when the column's ciphertext layout is dispatched by a sibling
   * codec column (the document vault's `contentCodec`: "base64v1" = the
   * `encrypt()`-string-as-UTF-8 shape every other Bytes column uses,
   * "binary2" = the binary `encryptBytes()` layout). A codec-dispatched
   * column also rotates in bounded id-cursor batches — its rows are
   * multi-megabyte blobs, so an unbounded `findMany` would balloon memory.
   */
  readonly codecField?: string;
  /**
   * The codec every row of the column uses, for a column with one layout and
   * no sibling column recording it. "binary2" is the binary `encryptBytes()`
   * layout. Like `codecField`, it implies batching.
   */
  readonly codec?: "binary2";
  /**
   * Walk this column in bounded id-cursor batches instead of one `findMany`.
   * Set it on any column whose rows are blobs rather than short strings — a
   * whole-account backup compresses to megabytes, and pulling every row of
   * them into one array is how the weekly backup pass died before
   * `packBackupBlob` existed. `codecField` implies batching.
   */
  readonly batched?: boolean;
  /**
   * The column is a cache, not a record. Rotation still re-encrypts it, but a
   * row it cannot read is DELETED rather than counted as an error: the value
   * is reproducible, and leaving an undecryptable row behind would hand the
   * next reader a body it cannot parse. Never set this on anything a user
   * would notice the loss of.
   */
  readonly disposable?: boolean;
  /**
   * The model's primary-key field, when it is not `id`. The rotation walk
   * selects it, orders by it and addresses each row through it, so a model
   * keyed on something else (`MoodContext.moodEntryId`) crashes the whole run
   * without this — Prisma rejects the unknown `id` in the select, and every
   * column after it in the pass is left un-rotated.
   */
  readonly pkField?: string;
}

/**
 * Every reversibly-encrypted column. HMAC-hashed columns (`*Hash`,
 * `tokenHash`) and the `refresh_token`-convention columns are deliberately
 * EXCLUDED — they are one-way and have no rotation path.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  // ───── User — integration credentials + AI keys + KVNR ─────
  { model: "User", field: "codexAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "codexRefreshTokenEncrypted", kind: "string" },
  { model: "User", field: "telegramBotToken", kind: "string" },
  { model: "User", field: "withingsClientIdEncrypted", kind: "string" },
  { model: "User", field: "withingsClientSecretEncrypted", kind: "string" },
  { model: "User", field: "whoopClientIdEncrypted", kind: "string" },
  { model: "User", field: "whoopClientSecretEncrypted", kind: "string" },
  { model: "User", field: "fitbitClientIdEncrypted", kind: "string" },
  { model: "User", field: "fitbitClientSecretEncrypted", kind: "string" },
  // v1.27.0 — Google Health (Fitbit / Pixel Watch) BYO OAuth client.
  { model: "User", field: "googleHealthClientIdEncrypted", kind: "string" },
  { model: "User", field: "googleHealthClientSecretEncrypted", kind: "string" },
  { model: "User", field: "nightscoutUrlEncrypted", kind: "string" },
  { model: "User", field: "nightscoutTokenEncrypted", kind: "string" },
  { model: "User", field: "polarAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "polarUserIdEncrypted", kind: "string" },
  { model: "User", field: "polarClientIdEncrypted", kind: "string" },
  { model: "User", field: "polarClientSecretEncrypted", kind: "string" },
  { model: "User", field: "ouraAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "ouraRefreshTokenEncrypted", kind: "string" },
  { model: "User", field: "ouraClientIdEncrypted", kind: "string" },
  { model: "User", field: "ouraClientSecretEncrypted", kind: "string" },
  { model: "User", field: "stravaClientIdEncrypted", kind: "string" },
  { model: "User", field: "stravaClientSecretEncrypted", kind: "string" },
  { model: "User", field: "stravaAccessTokenEncrypted", kind: "string" },
  { model: "User", field: "stravaRefreshTokenEncrypted", kind: "string" },
  { model: "User", field: "aiAnthropicKeyEncrypted", kind: "string" },
  { model: "User", field: "aiLocalKeyEncrypted", kind: "string" },
  { model: "User", field: "aiOpenaiKeyEncrypted", kind: "string" },
  // v1.33.1 (#470) — the OpenAI-compatible gateway provider's optional bearer.
  // A dedicated column, never the OpenAI key: the gateway host is user-chosen,
  // so the credential that reaches it must be one the user issued for it.
  { model: "User", field: "aiCompatKeyEncrypted", kind: "string" },
  { model: "User", field: "insuranceNumberEncrypted", kind: "string" },
  // v1.23 — TOTP shared secret (second factor). String ciphertext like the
  // other User credential columns.
  { model: "User", field: "totpSecretEncrypted", kind: "string" },

  // ───── OAuth token tables (`*_token`-convention columns) ─────
  { model: "WithingsConnection", field: "accessToken", kind: "string" },
  { model: "WithingsConnection", field: "refreshToken", kind: "string" },
  { model: "WhoopConnection", field: "accessToken", kind: "string" },
  { model: "WhoopConnection", field: "refreshToken", kind: "string" },
  { model: "FitbitConnection", field: "accessToken", kind: "string" },
  { model: "FitbitConnection", field: "refreshToken", kind: "string" },
  { model: "GoogleHealthConnection", field: "accessToken", kind: "string" },
  { model: "GoogleHealthConnection", field: "refreshToken", kind: "string" },

  // ───── AppSettings — operator credentials ─────
  { model: "AppSettings", field: "adminAiKeyEncrypted", kind: "string" },
  {
    model: "AppSettings",
    field: "webPushVapidPrivateKeyEncrypted",
    kind: "string",
  },
  // Operator-shared central Codex (ChatGPT subscription) OAuth credential — the
  // access token, the rotating refresh token, and the mandatory
  // `ChatGPT-Account-ID` claim, each AES-256-GCM at rest like the per-user
  // `codex*Encrypted` columns.
  {
    model: "AppSettings",
    field: "adminCodexAccessTokenEncrypted",
    kind: "string",
  },
  {
    model: "AppSettings",
    field: "adminCodexRefreshTokenEncrypted",
    kind: "string",
  },
  {
    model: "AppSettings",
    field: "adminCodexAccountIdEncrypted",
    kind: "string",
  },

  // ───── Custom labels (mood + cycle) ─────
  { model: "MoodTag", field: "labelEncrypted", kind: "string" },
  { model: "MoodTagCategory", field: "labelEncrypted", kind: "string" },
  { model: "CycleSymptom", field: "labelEncrypted", kind: "string" },

  // ───── Notification + push secrets ─────
  { model: "NotificationChannel", field: "config", kind: "string" },
  { model: "PushSubscription", field: "p256dh", kind: "string" },
  { model: "PushSubscription", field: "auth", kind: "string" },

  // ───── Integration status error payloads ─────
  { model: "IntegrationStatus", field: "lastError", kind: "string" },

  // ───── Cycle day-log sensitive payloads (String?) ─────
  { model: "CycleDayLog", field: "sensitiveEncrypted", kind: "string" },
  { model: "CycleDayLog", field: "notesEncrypted", kind: "string" },

  // ───── Coach (Bytes columns) ─────
  { model: "CoachMessage", field: "encryptedContent", kind: "bytes" },
  { model: "CoachConversation", field: "summaryEncrypted", kind: "bytes" },
  { model: "CoachFact", field: "factEncrypted", kind: "bytes" },
  // v1.21.3 (B1) — Coach goal / if-then plan free-text columns.
  { model: "CoachPlan", field: "ifCueEncrypted", kind: "bytes" },
  { model: "CoachPlan", field: "thenActionEncrypted", kind: "bytes" },
  { model: "CoachPlan", field: "targetEncrypted", kind: "bytes" },
  // v1.22 (W9, C2) — n-of-1 experiment outcome read-back prose.
  { model: "CoachPlan", field: "outcomeEncrypted", kind: "bytes" },
  // v1.22 (B2/B6) — Coach episodic reminder free-text note.
  { model: "CoachReminder", field: "noteEncrypted", kind: "bytes" },

  // ───── User health profile (Bytes columns) ─────
  { model: "UserHealthProfile", field: "aboutMeEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "conditionsEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "allergiesEncrypted", kind: "bytes" },
  { model: "UserHealthProfile", field: "coachFocusEncrypted", kind: "bytes" },
  {
    model: "UserHealthProfile",
    field: "pendingQuestionsEncrypted",
    kind: "bytes",
  },
  // v1.38 — emergency ("Notfalldaten") free text: contacts, implants/devices,
  // and the ICE note. Same Bytes codec as the self-context columns above; the
  // three enum companions (blood type, organ-donor, advance-directive) are
  // plaintext closed sets and are deliberately NOT here.
  {
    model: "UserHealthProfile",
    field: "emergencyContactsEncrypted",
    kind: "bytes",
  },
  {
    model: "UserHealthProfile",
    field: "emergencyImplantsEncrypted",
    kind: "bytes",
  },
  {
    model: "UserHealthProfile",
    field: "emergencyNoteEncrypted",
    kind: "bytes",
  },

  // ───── Effective-dated health profile facts (Bytes column) ─────
  {
    model: "HealthProfileFactRevision",
    field: "valueEncrypted",
    kind: "bytes",
  },

  // ───── Insight narratives (Bytes column) ─────
  { model: "InsightNarrative", field: "encryptedContent", kind: "bytes" },

  // ───── v1.39.0 status notes (Bytes columns) ─────
  // Both nullable: a row can carry only a negative-cache window, and only the
  // medication-compliance card stores per-item lines.
  { model: "InsightStatusCache", field: "textEncrypted", kind: "bytes" },
  { model: "InsightStatusCache", field: "itemsEncrypted", kind: "bytes" },

  // ───── v1.31.0 data-arrival spine (Bytes column) ─────
  // Nullable: the reaction marker is written on every salient arrival, but the
  // generated line only exists where a provider was reachable and in budget.
  // `rotateBytesColumn` skips a NULL/empty payload, so a provider-less
  // install's rows rotate as a clean no-op.
  { model: "ArrivalReaction", field: "lineEncrypted", kind: "bytes" },

  // ───── v1.31.0 per-workout Activity Insight (Bytes column) ─────
  // NOT nullable: a row exists only once a paragraph was actually generated,
  // so every row here carries ciphertext and every one must rotate.
  { model: "WorkoutInsight", field: "paragraphEncrypted", kind: "bytes" },

  // ───── v1.18.1 clinical-spine notes (Bytes columns) ─────
  { model: "LabResult", field: "noteEncrypted", kind: "bytes" },
  { model: "Biomarker", field: "contextEncrypted", kind: "bytes" },
  { model: "IllnessEpisode", field: "noteEncrypted", kind: "bytes" },
  { model: "IllnessDayLog", field: "noteEncrypted", kind: "bytes" },

  // ───── v1.19.0 ECG waveform (Bytes column) ─────
  { model: "EcgRecording", field: "waveformEncrypted", kind: "bytes" },

  // ───── v1.23 free-text health notes (Bytes columns) ─────
  // Free-text mood diary + per-measurement notes. Same class as the
  // IllnessDayLog / LabResult note columns above; Bytes via the shared codec.
  { model: "MoodEntry", field: "noteEncrypted", kind: "bytes" },
  { model: "Measurement", field: "notesEncrypted", kind: "bytes" },
  // v1.38 — the one free-text note on a mood entry's day context. Same codec
  // as the entry note beside it; one column for the whole context rather than
  // one per section, so there is one rotation entry rather than four.
  {
    model: "MoodContext",
    field: "notesEncrypted",
    kind: "bytes",
    pkField: "moodEntryId",
  },

  // ───── v1.25 medication free-text notes (Bytes columns) ─────
  // Side-effect log note, dose-change titration note, and inventory-item
  // note — the last plaintext PHI columns left after the v1.23 rollout.
  { model: "MedicationSideEffect", field: "notesEncrypted", kind: "bytes" },
  { model: "MedicationDoseChange", field: "noteEncrypted", kind: "bytes" },
  { model: "MedicationInventoryItem", field: "notesEncrypted", kind: "bytes" },

  // ───── v1.25 mental-health screener item answers (Bytes column) ─────
  // The PHQ-9 / GAD-7 per-item responses (incl. the safety-critical item 9)
  // ride a single AES-256-GCM blob. The most sensitive payload in the wave;
  // never indexed, never logged, never in wide-event meta.
  {
    model: "MentalHealthAssessment",
    field: "responsesEncrypted",
    kind: "bytes",
  },
  // ───── v1.25 structured health records (Bytes columns) ─────
  // Allergy free-text reaction + note, and the family-history note. The
  // structured enum/label columns stay queryable plaintext; only the
  // sensitive free-text fields are encrypted.
  { model: "Allergy", field: "reactionEncrypted", kind: "bytes" },
  { model: "Allergy", field: "notesEncrypted", kind: "bytes" },
  { model: "FamilyHistoryEntry", field: "notesEncrypted", kind: "bytes" },

  // ───── v1.38.0 visit free text (Bytes columns) ─────
  // Why the person went, what came out of it, and the practice note. The
  // structured columns a picker sorts and searches on — the practitioner's
  // name, the kind, the status — stay queryable plaintext, the same split the
  // structured health records above make.
  { model: "Encounter", field: "reasonEncrypted", kind: "bytes" },
  { model: "Encounter", field: "outcomeEncrypted", kind: "bytes" },
  // v1.39.1 — where on the body a procedure was done. The side beside it
  // (`laterality`) stays plaintext: a side alone says nothing.
  { model: "Encounter", field: "bodySiteEncrypted", kind: "bytes" },
  { model: "Practitioner", field: "noteEncrypted", kind: "bytes" },

  // ───── v1.38.0 dose free text (Bytes column) ─────
  // What the person wrote about the dose — a reaction, a sore arm, why the
  // schedule went the way it did. The Pass's own structured fields stay
  // queryable plaintext (the batch code is a batch code, not a secret), so
  // this is the one column on the record that rotates.
  { model: "VaccinationRecord", field: "noteEncrypted", kind: "bytes" },

  // ───── Inbound clinical document (Bytes column, codec-dispatched) ─────
  // The raw uploaded document (the most sensitive blob in the corpus; never
  // logged, never in wide-event meta). Two layouts, recorded per row in
  // `contentCodec`: "base64v1" (pre-vault rows — base64-of-binary →
  // AES-256-GCM string → UTF-8 bytes) and "binary2" (vault uploads — the
  // binary `encryptBytes()` layout). Rotation walks this column in bounded
  // id-cursor batches and re-encrypts under the row's own codec.
  {
    model: "InboundDocument",
    field: "contentEncrypted",
    kind: "bytes",
    codecField: "contentCodec",
  },
  // The staged extracted-fact payloads: the FHIR-staged clinical values
  // (diagnosis text / lab values / medication names / stated codes) and the
  // verbatim source-span provenance. Both are PHI transcribed from the source
  // document, so the staging rows carry the same at-rest guarantee as the
  // document itself rather than persisting as plaintext JSONB.
  { model: "ExtractedFact", field: "dataEncrypted", kind: "bytes" },
  { model: "ExtractedFact", field: "provenanceEncrypted", kind: "bytes" },
  // The short plain-language document summary, generated once in the background
  // after upload. Stored as the `encrypt()`-string-as-UTF-8 Bytes shape (the
  // same codec the content index + note columns use), so the generic Bytes walk
  // re-encrypts it. Nullable — pre-summary and opt-out rows are skipped
  // generically, as for every other nullable Bytes column.
  { model: "InboundDocument", field: "summaryEncrypted", kind: "bytes" },

  // ───── v1.27.22 document content-search index (Bytes text) ─────
  // The normalised extracted text of an indexed document, AES-256-GCM at rest
  // in the `encrypt()`-string-as-UTF-8 Bytes shape. Rotation re-encrypts it AND
  // re-tokenises the sibling blind token array from the decrypted text under the
  // new active index subkey (P2-D7) — a dedicated block in the rotation script,
  // not the generic Bytes walk. The `search_tokens` array itself is one-way
  // (HMAC) and is not a registry column.
  { model: "DocumentContentIndex", field: "textEncrypted", kind: "bytes" },
  // v1.27.33 (Document vault P4) — the VERBATIM extracted text (raw casing/
  // accents), stored additionally alongside `textEncrypted` for faithful
  // citation in the document chat. Same AES-256-GCM Bytes codec; rotation
  // re-encrypts it on the generic Bytes walk (nullable rows — indexed before P4
  // — are skipped generically, as for every other nullable Bytes column).
  {
    model: "DocumentContentIndex",
    field: "verbatimTextEncrypted",
    kind: "bytes",
  },
  // Document vault — the small JPEG preview thumbnail. Stored as the
  // `encrypt()`-string-as-UTF-8 Bytes shape (base64 of the JPEG), the same
  // codec `DocumentContentIndex.textEncrypted` uses. A scanned medical preview
  // is PHI; rotation re-encrypts it on the standard Bytes walk.
  { model: "DocumentThumbnail", field: "thumbnailEncrypted", kind: "bytes" },

  // ───── Whole-account backup blob (String, batched) ─────
  // The weekly disaster-recovery snapshot and every manually uploaded pack.
  // Named `data`, so the `*Encrypted` scan never saw it; the value is
  // `packBackupBlob()` output, which is AES-256-GCM ciphertext like every
  // other entry here. It is also the single worst column to miss: a backup
  // that cannot be decrypted is the copy an operator reaches for precisely
  // when nothing else works.
  //
  // Rotation re-encrypts the ciphertext WITHOUT touching the plaintext, so it
  // is blind to the envelope inside: a row is the plain backup JSON, the
  // `HLZ1:`-prefixed gzip form, or the single `~hlgcm1.` stream v1.39.1 wrote
  // (re-sealed as a stream). Batched, because a single row is megabytes.
  { model: "DataBackup", field: "data", kind: "string", batched: true },

  // ───── Whole-account backup, in pieces (Bytes, binary2, batched) ─────
  // How every backup is stored from v1.39.2: ordered pieces of about a
  // megabyte, each sealed with `encryptBytes()` (`backup-chunks.ts`). The
  // column above keeps only copies written before that. Rotation re-seals a
  // piece without reading what it holds; the header that binds it to its copy
  // and position is inside the ciphertext, so it survives unchanged.
  {
    model: "DataBackupChunk",
    field: "data",
    kind: "bytes",
    codec: "binary2",
  },

  // ───── Idempotent-replay response cache (String, disposable) ─────
  // The cached response body, encrypted because the PHI-returning creates echo
  // their own decrypted DTO. Rows live 24 hours. It is registered so a key
  // drop cannot leave a reader holding an undecryptable body, and marked
  // disposable so an unreadable row is dropped instead of failing the run —
  // the cache is an accelerator, and a miss only costs a re-run.
  {
    model: "IdempotencyKey",
    field: "responseBody",
    kind: "string",
    disposable: true,
  },
] as const;

/** Stable `Model.field` key for a registry entry. */
export function encryptedColumnKey(c: EncryptedColumn): string {
  return `${c.model}.${c.field}`;
}
