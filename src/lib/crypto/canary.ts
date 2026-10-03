/**
 * Boot check: does the configured encryption key open this database?
 *
 * Without it, a server started with a different `ENCRYPTION_KEY` than the one
 * its database was written with (a reinstalled NAS app over an old dataset, a
 * restored dump under a fresh key) signs people in normally, because sessions
 * hash with `API_TOKEN_HMAC_KEY`, and then answers random 500s wherever a value
 * has to be decrypted. This module turns that into one clear refusal.
 *
 * For every configured key id, `encryption_key_canaries` holds a known
 * plaintext sealed under that key:
 *
 *   - row present: it must decrypt to the expected value, else the key is not
 *     the one the row was written with;
 *   - row absent: before writing one, probe the ciphertext already stored
 *     under that key id. Without the probe, the first boot after an upgrade
 *     (or a re-keyed boot over a database that predates the canary) would
 *     seal the wrong key as the right one, and from then on refuse the
 *     right key.
 *
 * ## The probe
 *
 * Every registered column is asked, string and Bytes alike (`ENCRYPTED_COLUMNS`),
 * for its OLDEST values under the key id: the `encrypt()` string form
 * (`<keyId>.<base64>`, or a bare legacy base64 value for the legacy id `v1`),
 * the streamed form (`~hlgcm1.<keyId>.`), the same string stored as UTF-8 in a
 * Bytes column, and the binary layout (`0x02 <len> <keyId>`). The answer for a
 * column also tells whether it holds ANY value under the id, which is the
 * existence check below.
 *
 * Oldest means the row's `updatedAt`, else its `createdAt`, else (no timestamp
 * on the model, e.g. backup pieces) the primary key, ordered after every
 * timestamped row. `updatedAt` rather than `createdAt` because a value is
 * sealed when its row is written, and a row updated yesterday may carry a
 * value sealed yesterday on a row created years ago; `updatedAt` is a ceiling
 * on when the value was sealed. The point of the order: a process that served
 * under a wrong key without a canary (an inconclusive boot, a version that
 * predates this check) wrote rows that open under that wrong key. Those rows
 * are by construction newer than the data the database was built with, so
 * reading the oldest values first means they are never what decides.
 *
 * Up to `PROBE_ROWS_PER_COLUMN` values per column are fetched, the merged set
 * is ordered by that timestamp, and the oldest `PROBE_SAMPLE_LIMIT` are tried.
 * Values larger than `PROBE_VALUE_MAX_BYTES` (stored documents, large backups)
 * count as present but are not fetched. The verdict:
 *
 *   - `opens`: the oldest value that opens is preceded by at most ONE older
 *     value that does not. That one is a damaged or foreign row, not a key
 *     problem: a wrong key opens nothing. Values newer than the first opening
 *     one do not count against it; they are what a wrong-key process would
 *     have left behind. The canary is written.
 *   - `fails`: two or more values were tried and none opened. That is what a
 *     wrong key looks like; the process refuses (mismatch).
 *   - `none`: every column answered, and none holds a single value under the
 *     key id. A genuinely fresh install (or a new id added for rotation); the
 *     canary is written.
 *   - `inconclusive`, with a reason: anything not proven. Only one value and
 *     it did not open (`single-value`); two or more of the oldest values do
 *     not open but a newer one does (`mixed`); values exist but none could be
 *     fetched (`unsampled`); the time budget ran out or a column could not be
 *     read (`incomplete`). The process serves, as before this check existed,
 *     writes NO canary, logs a warning, and probes again at the next boot.
 *     Serving rather than refusing because a refusal takes a correctly keyed
 *     server down with 503 on every request; not sealing because that would
 *     lock the right key out later.
 *
 * The first seal can race another process. `ON CONFLICT DO NOTHING` keeps the
 * row the other process wrote; when this process's insert affected no row,
 * the stored canary is read back and must open under this process's key, or
 * the outcome is a mismatch.
 *
 * Never logs or returns key material. The canary is written by raw SQL and is
 * deliberately not in the rotation registry: it belongs to its key id, and the
 * rotation script removes it once no ciphertext remains under that id
 * (`retireCanariesWithoutData`).
 */
import {
  decrypt,
  decryptBytes,
  decryptStream,
  encryptUnderKeyId,
  extractKeyId,
  extractKeyIdFromBytes,
  extractStreamKeyId,
  getActiveKeyId,
  getConfiguredKeyIds,
  isStreamCiphertext,
} from "@/lib/crypto";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnKey,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";

export const CANARY_PREFIX = "healthlog-canary:";

export function canaryPlaintext(keyId: string): string {
  return `${CANARY_PREFIX}${keyId}`;
}

/** How many of the oldest values the probe tries at most per key id. */
export const PROBE_SAMPLE_LIMIT = 8;

/** How many of its oldest values each column contributes to the pool. */
export const PROBE_ROWS_PER_COLUMN = 2;

/** Values larger than this count as present but are not fetched. */
export const PROBE_VALUE_MAX_BYTES = 2 * 1024 * 1024;

/** How long the probe may take before it gives up as `inconclusive`. */
export const PROBE_BUDGET_MS = 10_000;

/** The key id the legacy bare-base64 string format belongs to. */
const LEGACY_KEY_ID = "v1";

/** The slice of a Prisma client this module needs. */
export interface CanaryClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  $queryRawUnsafe?<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T>;
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<number>;
}

/** One stored value under the key id, as the probe sees it. */
export interface ProbeRow {
  /** The stored value; null when it exists but is too large to fetch. */
  value: string | Uint8Array | null;
  /** The row's codec column, for a codec-dispatched column. */
  codec?: string | null;
  /** The row's write time (see the module comment); null when it has none. */
  ts: Date | null;
}

/**
 * Reads up to `limit` of the oldest values under `keyId` in one column, oldest
 * first. Throws when the column cannot be read; an empty array means the
 * column holds no value under that id.
 */
export type ColumnSampler = (
  column: EncryptedColumn,
  keyId: string,
  limit: number,
) => Promise<ProbeRow[]>;

export type InconclusiveReason =
  "single-value" | "mixed" | "unsampled" | "incomplete";

export type ProbeResult =
  | { verdict: "opens" | "fails" | "none" }
  | { verdict: "inconclusive"; reason: InconclusiveReason };

export type KeyCheckOutcome =
  | {
      state: "ok";
      /** Key ids whose canary this run wrote. */
      written: string[];
      /** Key ids whose canary existed (or another process wrote) and opened. */
      verified: string[];
      /**
       * Key ids with no canary whose stored data proved nothing either way:
       * not a mismatch, no canary written, probed again at the next boot.
       */
      inconclusive: Array<{ keyId: string; reason: InconclusiveReason }>;
    }
  | { state: "mismatch"; keyIds: string[] }
  | { state: "error"; message: string };

function opensAs(ciphertext: string, keyId: string, expected?: string) {
  try {
    if (extractKeyId(ciphertext) !== keyId) return false;
    const plain = decrypt(ciphertext);
    return expected === undefined ? true : plain === expected;
  } catch {
    return false;
  }
}

function isBinaryLayout(column: EncryptedColumn, row: ProbeRow): boolean {
  if (column.codec === "binary2") return true;
  return column.codecField !== undefined && row.codec === "binary2";
}

/** Does one stored value open under `keyId`? Never throws. */
export function probeValueOpens(
  column: EncryptedColumn,
  row: ProbeRow,
  keyId: string,
): boolean {
  const value = row.value;
  if (value === null) return false;
  try {
    if (typeof value === "string") {
      if (isStreamCiphertext(value)) {
        if (extractStreamKeyId(value) !== keyId) return false;
        decryptStream(value);
        return true;
      }
      const id = extractKeyId(value);
      if (id === null) {
        // Legacy bare base64: only ever the legacy id's.
        if (keyId !== LEGACY_KEY_ID) return false;
        decrypt(value);
        return true;
      }
      return opensAs(value, keyId);
    }
    const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (isBinaryLayout(column, row)) {
      if (extractKeyIdFromBytes(buf) !== keyId) return false;
      decryptBytes(buf, column.aad);
      return true;
    }
    return opensAs(buf.toString("utf8"), keyId);
  } catch {
    return false;
  }
}

/**
 * Probe the stored values under `keyId`; see the module comment for what each
 * verdict means and why.
 */
export async function probeExistingData(
  sampler: ColumnSampler,
  keyId: string,
  deadline: number,
  columns: readonly EncryptedColumn[] = ENCRYPTED_COLUMNS,
): Promise<ProbeResult> {
  const pool: Array<{ column: EncryptedColumn; row: ProbeRow; order: number }> =
    [];
  let present = 0;
  for (const column of columns) {
    if (Date.now() > deadline) {
      return { verdict: "inconclusive", reason: "incomplete" };
    }
    let rows: ProbeRow[];
    try {
      rows = await sampler(column, keyId, PROBE_ROWS_PER_COLUMN);
    } catch {
      return { verdict: "inconclusive", reason: "incomplete" };
    }
    present += rows.length;
    for (const row of rows) {
      if (row.value !== null) pool.push({ column, row, order: pool.length });
    }
  }
  if (Date.now() > deadline) {
    return { verdict: "inconclusive", reason: "incomplete" };
  }
  if (present === 0) return { verdict: "none" };
  if (pool.length === 0) {
    return { verdict: "inconclusive", reason: "unsampled" };
  }

  // Oldest first; rows without a timestamp after every row with one.
  pool.sort((a, b) => {
    const ta = a.row.ts?.getTime() ?? Number.POSITIVE_INFINITY;
    const tb = b.row.ts?.getTime() ?? Number.POSITIVE_INFINITY;
    return ta === tb ? a.order - b.order : ta - tb;
  });
  const tried = pool.slice(0, PROBE_SAMPLE_LIMIT);

  let failedBeforeFirstOpen = 0;
  for (const { column, row } of tried) {
    if (probeValueOpens(column, row, keyId)) {
      return failedBeforeFirstOpen <= 1
        ? { verdict: "opens" }
        : { verdict: "inconclusive", reason: "mixed" };
    }
    failedBeforeFirstOpen += 1;
  }
  return tried.length >= 2
    ? { verdict: "fails" }
    : { verdict: "inconclusive", reason: "single-value" };
}

// ─── The SQL sampler ────────────────────────────────────────────────────────

interface ColumnLocation {
  table: string;
  column: string;
  pk: string;
  ts: string | null;
  codec: string | null;
}

type RuntimeDataModel = {
  models: Record<
    string,
    {
      dbName: string | null;
      fields: Array<{ name: string; dbName?: string | null }>;
    }
  >;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unexpected identifier in the column registry: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Table and column names for a registry entry, read from the Prisma client's
 * runtime data model (the same `@@map` / `@map` names the client queries
 * with). `canary.test.ts` pins that every registry column resolves, so a
 * Prisma upgrade that moves this fails a test rather than the probe.
 */
export function resolveColumnLocation(
  client: unknown,
  column: EncryptedColumn,
): ColumnLocation {
  const dm = (client as { _runtimeDataModel?: RuntimeDataModel })
    ._runtimeDataModel;
  const model = dm?.models?.[column.model];
  if (!model) {
    throw new Error(`No data model for ${column.model}`);
  }
  const dbField = (name: string): string | null => {
    const f = model.fields.find((x) => x.name === name);
    return f ? (f.dbName ?? f.name) : null;
  };
  const columnName = dbField(column.field);
  const pk = dbField(column.pkField ?? "id");
  if (!columnName || !pk) {
    throw new Error(`No column for ${encryptedColumnKey(column)}`);
  }
  return {
    table: model.dbName ?? column.model,
    column: columnName,
    pk,
    ts: dbField("updatedAt") ?? dbField("createdAt"),
    codec: column.codecField ? dbField(column.codecField) : null,
  };
}

/**
 * The SQL that finds values under `keyId` in one column. Identifiers come from
 * the Prisma data model and are checked against `IDENTIFIER` before they are
 * spliced; the key id is checked against the key-id grammar and travels as a
 * bound parameter. The prefix tests use `substr` / `substring`, which read
 * only the head of a large out-of-line value instead of the whole of it.
 */
function columnQuery(
  loc: ColumnLocation,
  column: EncryptedColumn,
  keyId: string,
  mode: "sample" | "exists",
): { sql: string; params: unknown[] } {
  if (!KEY_ID.test(keyId)) throw new Error("Malformed key id");
  const c = quoteIdentifier(loc.column);
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const tests: string[] = [];
  if (column.kind === "string") {
    const versioned = `${keyId}.`;
    const streamed = `~hlgcm1.${keyId}.`;
    tests.push(
      `substr(${c}, 1, ${versioned.length}) = ${bind(versioned)}`,
      `substr(${c}, 1, ${streamed.length}) = ${bind(streamed)}`,
    );
    if (keyId === LEGACY_KEY_ID) {
      // A legacy value is bare base64 of at least IV + tag + one block.
      tests.push(`substr(${c}, 1, 40) ~ '^[A-Za-z0-9+/]{40}$'`);
    }
  } else {
    const utf8 = Buffer.from(`${keyId}.`, "ascii");
    const id = Buffer.from(keyId, "ascii");
    const binary = Buffer.concat([Buffer.from([0x02, id.length]), id]);
    if (column.codec !== "binary2") {
      tests.push(
        `substring(${c} from 1 for ${utf8.length}) = ${bind(utf8)}::bytea`,
      );
    }
    if (column.codec === "binary2" || column.codecField) {
      tests.push(
        `substring(${c} from 1 for ${binary.length}) = ${bind(binary)}::bytea`,
      );
    }
  }
  const table = quoteIdentifier(loc.table);
  const where = `${c} IS NOT NULL AND (${tests.join(" OR ")})`;
  if (mode === "exists") {
    return {
      sql: `SELECT 1 AS one FROM ${table} WHERE ${where} LIMIT 1`,
      params,
    };
  }
  const ts = loc.ts ? quoteIdentifier(loc.ts) : null;
  const codec = loc.codec ? quoteIdentifier(loc.codec) : "NULL";
  const max = Math.floor(PROBE_VALUE_MAX_BYTES);
  const sql =
    `SELECT CASE WHEN octet_length(${c}) <= ${max} THEN ${c} END AS value, ` +
    `${codec} AS codec, ${ts ?? "NULL::timestamp"} AS ts ` +
    `FROM ${table} WHERE ${where} ` +
    `ORDER BY ${ts ? `${ts} ASC NULLS LAST, ` : ""}${quoteIdentifier(loc.pk)} ASC ` +
    `LIMIT ${bind(0)}`;
  return { sql, params };
}

function requireUnsafe(client: CanaryClient) {
  const query = client.$queryRawUnsafe;
  if (typeof query !== "function") {
    throw new Error("The database client cannot run the probe queries");
  }
  return query.bind(client);
}

/** The production sampler: one bounded query per column. */
export function sqlColumnSampler(client: CanaryClient): ColumnSampler {
  const query = requireUnsafe(client);
  return async (column, keyId, limit) => {
    const loc = resolveColumnLocation(client, column);
    const { sql, params } = columnQuery(loc, column, keyId, "sample");
    params[params.length - 1] = limit;
    const rows = await query<
      Array<{
        value: string | Uint8Array | null;
        codec: string | null;
        ts: Date | null;
      }>
    >(sql, ...params);
    return rows.map((r) => ({
      value: r.value,
      codec: r.codec,
      ts: r.ts instanceof Date ? r.ts : r.ts ? new Date(r.ts) : null,
    }));
  };
}

/**
 * Every registered column that still holds a value under `keyId`, by
 * `Model.field`. Exhaustive: one existence query per column, no budget.
 */
export async function columnsHoldingKeyId(
  client: CanaryClient,
  keyId: string,
): Promise<string[]> {
  const query = requireUnsafe(client);
  const holding: string[] = [];
  for (const column of ENCRYPTED_COLUMNS) {
    const loc = resolveColumnLocation(client, column);
    const { sql, params } = columnQuery(loc, column, keyId, "exists");
    const rows = await query<unknown[]>(sql, ...params);
    if (rows.length > 0) holding.push(encryptedColumnKey(column));
  }
  return holding;
}

// ─── The check ──────────────────────────────────────────────────────────────

/**
 * Run the check for every configured key id. Never throws: a failure to run
 * the check at all is reported as `error`, and only values that provably do
 * not open are reported as `mismatch`.
 */
export async function checkEncryptionKeyCanaries(
  client: CanaryClient,
  options: {
    probeBudgetMs?: number;
    sampler?: ColumnSampler;
    /**
     * `warn` (`ENCRYPTION_KEY_CHECK=warn`): record nothing unless every key
     * id passed. The process serves whatever the outcome, so a key that is
     * not proven for every id must not be recorded beside it.
     */
    mode?: "enforce" | "warn";
  } = {},
): Promise<KeyCheckOutcome> {
  let keyIds: string[];
  try {
    keyIds = getConfiguredKeyIds();
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }

  let rows: Array<{ key_id: string; ciphertext: string }>;
  try {
    rows = await client.$queryRaw<
      Array<{ key_id: string; ciphertext: string }>
    >`SELECT key_id, ciphertext FROM encryption_key_canaries WHERE key_id = ANY(${keyIds})`;
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }
  const stored = new Map(rows.map((r) => [r.key_id, r.ciphertext]));

  const mismatched: string[] = [];
  const verified: string[] = [];
  const missing: string[] = [];
  for (const keyId of keyIds) {
    const ciphertext = stored.get(keyId);
    if (ciphertext === undefined) {
      missing.push(keyId);
    } else if (opensAs(ciphertext, keyId, canaryPlaintext(keyId))) {
      verified.push(keyId);
    } else {
      mismatched.push(keyId);
    }
  }

  const deadline = Date.now() + (options.probeBudgetMs ?? PROBE_BUDGET_MS);
  const toWrite: string[] = [];
  const inconclusive: Array<{ keyId: string; reason: InconclusiveReason }> = [];
  if (missing.length > 0) {
    let sampler: ColumnSampler;
    try {
      sampler = options.sampler ?? sqlColumnSampler(client);
    } catch (err) {
      return { state: "error", message: (err as Error).message };
    }
    for (const keyId of missing) {
      const probe = await probeExistingData(sampler, keyId, deadline);
      if (probe.verdict === "fails") mismatched.push(keyId);
      else if (probe.verdict === "inconclusive") {
        inconclusive.push({ keyId, reason: probe.reason });
      } else toWrite.push(keyId);
    }
  }

  if (mismatched.length > 0) {
    // Nothing is written while any key fails: a process in this state must
    // not leave anything behind sealed under a key that may be wrong.
    return { state: "mismatch", keyIds: mismatched.sort() };
  }

  const written: string[] = [];
  const sealable =
    options.mode === "warn" && inconclusive.length > 0 ? [] : toWrite;
  try {
    for (const keyId of sealable) {
      const ciphertext = encryptUnderKeyId(canaryPlaintext(keyId), keyId);
      const inserted =
        await client.$executeRaw`INSERT INTO encryption_key_canaries (key_id, ciphertext) VALUES (${keyId}, ${ciphertext}) ON CONFLICT (key_id) DO NOTHING`;
      if (inserted > 0) {
        written.push(keyId);
        continue;
      }
      // Another process sealed this id first. Its canary has to open under
      // this process's key, or one of the two holds the wrong key.
      const [winner] = await client.$queryRaw<Array<{ ciphertext: string }>>`
        SELECT ciphertext FROM encryption_key_canaries WHERE key_id = ${keyId}`;
      if (winner && opensAs(winner.ciphertext, keyId, canaryPlaintext(keyId))) {
        verified.push(keyId);
      } else {
        mismatched.push(keyId);
      }
    }
  } catch (err) {
    return { state: "error", message: (err as Error).message };
  }
  if (mismatched.length > 0) {
    return { state: "mismatch", keyIds: mismatched.sort() };
  }

  return { state: "ok", written, verified, inconclusive };
}

/**
 * After a rotation: remove the canary of every configured key id other than
 * the active one that no longer holds a single value in any registered
 * column. The id's key can then leave `ENCRYPTION_KEYS`; and if the id is
 * ever reused for a different key, no stale canary refuses it.
 */
export async function retireCanariesWithoutData(client: CanaryClient): Promise<{
  removed: string[];
  remaining: Record<string, string[]>;
}> {
  const active = getActiveKeyId();
  const removed: string[] = [];
  const remaining: Record<string, string[]> = {};
  for (const keyId of getConfiguredKeyIds()) {
    if (keyId === active) continue;
    const holding = await columnsHoldingKeyId(client, keyId);
    if (holding.length > 0) {
      remaining[keyId] = holding;
      continue;
    }
    const deleted =
      await client.$executeRaw`DELETE FROM encryption_key_canaries WHERE key_id = ${keyId}`;
    if (deleted > 0) removed.push(keyId);
  }
  return { removed, remaining };
}

/**
 * The one block an operator reads in the container log. English literal on
 * purpose: logs are not translated. Names the key ids, never a key.
 */
export function keyMismatchLogBlock(keyIds: string[]): string {
  const ids = keyIds.map((id) => `'${id}'`).join(", ");
  return [
    "============================================================",
    " HealthLog refuses to serve: encryption key does not match",
    "============================================================",
    ` The encryption key configured for key id ${ids} cannot open the`,
    " data already stored in this database. Serving anyway would fail on",
    " every encrypted value, so every API request answers 503 with",
    " errorCode 'encryption.key_mismatch' and /api/health reports",
    " reason 'encryption_key_mismatch'. Background jobs are not started.",
    "",
    " Fix it one of three ways, then restart:",
    "  1. Restore the original ENCRYPTION_KEY (or ENCRYPTION_KEYS entry)",
    "     this database was written with.",
    "  2. Point DATABASE_URL at the database that belongs to this key.",
    "  3. Start fresh: an empty database with this key. Stored data and",
    "     in-database backups of the old database cannot be read without",
    "     the old key.",
    "",
    " Only if you are CERTAIN the configured key is the one this data was",
    " written with (the check recorded a different key earlier), reset the",
    " check and restart; it then probes the stored data again:",
    ...keyIds.map(
      (id) => `   DELETE FROM encryption_key_canaries WHERE key_id = '${id}';`,
    ),
    "",
    " Last resort, when no record exists yet to reset (a first start) and you",
    " are certain the key is right: ENCRYPTION_KEY_CHECK=warn serves anyway",
    " and only logs. It disables this safety check; with a wrong key every",
    " encrypted value then fails and new rows are written under that key.",
    "============================================================",
  ].join("\n");
}
