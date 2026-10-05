import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ENCRYPTED_COLUMNS,
  encryptedColumnKey,
  UPDATED_AT_MODELS,
  type EncryptedColumn,
} from "../encrypted-columns";

const ROOT = join(__dirname, "../../../..");
const SCHEMA_PATH = join(ROOT, "prisma", "schema.prisma");
const ROTATION_SCRIPT_PATH = join(ROOT, "scripts", "rotate-encryption-key.ts");

/**
 * Reversibly-encrypted columns whose Prisma field name does NOT end in
 * `Encrypted`. These are historically-named encrypted columns; they are
 * called out explicitly here so the schema scan can detect a NEW encrypted
 * column even when it follows the `*Encrypted` convention, without
 * mis-flagging unrelated columns. The scan's primary signal is the
 * `*Encrypted` suffix; this set covers the documented exceptions.
 */
const NON_SUFFIX_ENCRYPTED: ReadonlySet<string> = new Set([
  // WithingsConnection / WhoopConnection / FitbitConnection
  "accessToken",
  "refreshToken",
  // NotificationChannel
  "config",
  // PushSubscription
  "p256dh",
  "auth",
  // IntegrationStatus
  "lastError",
  // CoachMessage / InsightNarrative
  "encryptedContent",
  // User (Telegram)
  "telegramBotToken",
]);

/**
 * Columns that match the encrypted-column scan signal but are NOT
 * reversibly encrypted and therefore deliberately excluded from rotation.
 */
const NOT_ENCRYPTED: ReadonlySet<string> = new Set<string>([
  // RefreshToken.accessTokenHash — HMAC, one-way (no rotation path).
  "RefreshToken.accessTokenHash",
]);

interface SchemaColumn {
  model: string;
  field: string;
  /** "String" | "Bytes" | ... — the declared Prisma scalar. */
  type: string;
}

/**
 * Parse schema.prisma into (model, field, type) triples. Lightweight: tracks
 * the current `model X {` block and reads the first two tokens of each field
 * line.
 */
function parseSchemaColumns(): SchemaColumn[] {
  const src = readFileSync(SCHEMA_PATH, "utf8");
  const columns: SchemaColumn[] = [];
  let model: string | null = null;
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("///") || line === "") {
      continue;
    }
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) {
      model = modelMatch[1];
      continue;
    }
    if (line === "}") {
      model = null;
      continue;
    }
    if (!model) continue;
    // Field line: `<name> <Type>...`. Skip block attributes (`@@map`) and
    // relation/attribute-only lines.
    const fieldMatch = /^(\w+)\s+([A-Za-z]+)(\?|\[\])?/.exec(line);
    if (!fieldMatch) continue;
    columns.push({ model, field: fieldMatch[1], type: fieldMatch[2] });
  }
  return columns;
}

/**
 * Decide whether a schema column carries AES-256-GCM ciphertext. Signal:
 * the `*Encrypted` suffix, OR membership in the documented non-suffix set.
 */
function isEncryptedColumn(c: SchemaColumn): boolean {
  const key = `${c.model}.${c.field}`;
  if (NOT_ENCRYPTED.has(key)) return false;
  if (c.field.endsWith("Encrypted")) return true;
  return NON_SUFFIX_ENCRYPTED.has(c.field);
}

describe("encrypted-column registry", () => {
  it("has no duplicate entries", () => {
    const keys = ENCRYPTED_COLUMNS.map(encryptedColumnKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("registers encrypted health profile fact values as bytes", () => {
    expect(ENCRYPTED_COLUMNS).toContainEqual({
      model: "HealthProfileFactRevision",
      field: "valueEncrypted",
      kind: "bytes",
    });
  });

  it("assigns the right storage kind for each column type", () => {
    const schema = parseSchemaColumns();
    const typeByKey = new Map<string, string>(
      schema.map((c) => [`${c.model}.${c.field}`, c.type]),
    );
    for (const col of ENCRYPTED_COLUMNS) {
      const key = encryptedColumnKey(col);
      const type = typeByKey.get(key);
      expect(type, `registry column ${key} not found in schema`).toBeDefined();
      const expectedKind = type === "Bytes" ? "bytes" : "string";
      expect(col.kind, `${key} declared ${type} but kind=${col.kind}`).toBe(
        expectedKind,
      );
    }
  });

  it("covers EVERY encrypted column in prisma/schema.prisma", () => {
    const schema = parseSchemaColumns();
    const schemaEncrypted = schema
      .filter(isEncryptedColumn)
      .map((c) => `${c.model}.${c.field}`)
      .sort();
    const allSchemaColumns = new Set(
      schema.map((c) => `${c.model}.${c.field}`),
    );
    const registered = ENCRYPTED_COLUMNS.map(encryptedColumnKey).sort();

    // Any schema column the registry forgot is a rotation gap (data-loss
    // risk on key drop). Any registry column missing from the schema is a
    // stale entry. Both fail here.
    //
    // Staleness is checked against the WHOLE schema, not against the name
    // scan: the registry legitimately carries columns this scan cannot see —
    // `DataBackup.data` holds ciphertext under a name the convention does not
    // reach — and the sibling guard `encrypted-column-writers.test.ts` is
    // what finds those, by tracing the writers instead of the names.
    const missingFromRegistry = schemaEncrypted.filter(
      (k) => !registered.includes(k),
    );
    const staleInRegistry = registered.filter((k) => !allSchemaColumns.has(k));
    expect(
      missingFromRegistry,
      "encrypted schema columns NOT wired into the rotation registry",
    ).toEqual([]);
    expect(
      staleInRegistry,
      "registry columns that no longer exist in the schema",
    ).toEqual([]);
  });

  it("declares the primary key for every model not keyed on `id`", () => {
    // The rotation walk selects, orders by and addresses rows through this
    // field. Get it wrong and Prisma rejects the select at runtime, which
    // abandons the rest of the pass — a rotation that stops early looks the
    // same from the outside as one that had nothing to do.
    const src = readFileSync(SCHEMA_PATH, "utf8");
    const primaryKey = new Map<string, string>();
    let model: string | null = null;
    for (const rawLine of src.split("\n")) {
      const line = rawLine.trim();
      const head = /^model\s+(\w+)\s*\{/.exec(line);
      if (head) {
        model = head[1];
        continue;
      }
      if (line === "}") {
        model = null;
        continue;
      }
      if (!model) continue;
      const field = /^(\w+)\s+[A-Za-z]\w*\??\s.*@id\b/.exec(line);
      if (field) primaryKey.set(model, field[1]);
    }

    const wrong = (ENCRYPTED_COLUMNS as EncryptedColumn[])
      .filter((c) => (c.pkField ?? "id") !== primaryKey.get(c.model))
      .map(
        (c) =>
          `${encryptedColumnKey(c)} (schema key: ${primaryKey.get(c.model) ?? "none"})`,
      );
    expect(
      wrong,
      "registry entries whose pkField does not match the model's @id column",
    ).toEqual([]);
  });

  it("is fully referenced by the key-rotation script", () => {
    const script = readFileSync(ROTATION_SCRIPT_PATH, "utf8");
    // Field names are NOT unique across models (e.g. `noteEncrypted` lives on
    // five models, `notesEncrypted` on two, `accessToken`/`refreshToken` on
    // three connection tables each). A bare field-name substring match passes
    // on the first occurrence and is blind to a same-named sibling whose model
    // was never wired into rotation — exactly the "silently skipped →
    // undecryptable after the old key is dropped" failure the registry exists
    // to prevent. So require, per registry entry, BOTH the field literal AND
    // the model's Prisma delegate (`prisma.<delegate>`) to appear in the script
    // — the delegate proves that model's table is actually walked (some tables
    // are rotated through a shared `for (const field of [...])` loop, where the
    // field literal appears once but each delegate is named explicitly).
    const delegate = (model: string) =>
      `prisma.${model.charAt(0).toLowerCase()}${model.slice(1)}`;
    const unreferenced = (ENCRYPTED_COLUMNS as EncryptedColumn[])
      .filter(
        (c) =>
          !script.includes(`"${c.field}"`) ||
          !script.includes(delegate(c.model)),
      )
      .map(encryptedColumnKey);
    expect(
      unreferenced,
      "registry columns NOT fully referenced (field + model delegate) by scripts/rotate-encryption-key.ts",
    ).toEqual([]);
  });
});

describe("UPDATED_AT_MODELS", () => {
  it("lists exactly the registry models that carry @updatedAt in the schema", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const stamped = new Set<string>();
    for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      if (/@updatedAt\b/.test(m[2])) stamped.add(m[1]);
    }
    const registry = [...new Set(ENCRYPTED_COLUMNS.map((c) => c.model))];
    const expected = registry.filter((m) => stamped.has(m)).sort();
    expect(expected.length).toBeGreaterThan(20);
    expect([...UPDATED_AT_MODELS].sort()).toEqual(expected);
  });
});
