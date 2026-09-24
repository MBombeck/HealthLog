/**
 * Derive the ciphertext-bearing columns FROM THE CODE, then assert the
 * key-rotation registry covers every one of them.
 *
 * Why this exists next to `encrypted-columns.test.ts`. That guard scans
 * `schema.prisma` for the `*Encrypted` suffix plus a hand-kept list of
 * historically-named exceptions. The suffix is a naming convention, not a
 * fact about the value, and the moment a column holding ciphertext is called
 * something else the guard goes green while the column is unrotatable.
 * `DataBackup.data` — the whole-account backup blob — sat outside rotation
 * that way: encrypted on write, invisible to a name scan, and therefore
 * reported as "zero rows remaining" by a run that never looked at it. The
 * runbook then told the operator that zero meant the old key was safe to
 * drop, which would have destroyed every backup in the deployment.
 *
 * How the derivation works, in three steps:
 *
 *   1. Start from the two primitives in `src/lib/crypto.ts` (`encrypt`,
 *      `encryptBytes`) and close over every function that RETURNS a value
 *      derived from one — `packBackupBlob`, `encryptNote`, the per-domain
 *      `encrypt*ToBytes` codecs, and so on. Taint propagates only through
 *      pure expressions; anything awaited or read back from Prisma is a
 *      round-trip, not a ciphertext this code produced.
 *   2. Walk every `prisma|tx|db.<model>.<write>(...)` call, descend through
 *      the Prisma envelope keys (`data` / `create` / `update`, and relation
 *      writes resolved against the schema) into the payload objects, and
 *      record `<Model>.<field>` for each field whose value is a producer
 *      call or a variable derived from one.
 *   3. Assert the result is a subset of the rotation registry.
 *
 * Known limit, stated so it is not mistaken for coverage: a payload assembled
 * somewhere other than the call site (`data: updates` where `updates` is built
 * field by field) resolves to nothing here. Those columns are covered by the
 * name scan in the sibling guard; the two signals are deliberately
 * independent, and a column has to escape BOTH to go unregistered. The scan
 * asserts a non-zero, anchored match count, so a matcher that quietly stops
 * matching fails instead of passing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENCRYPTED_COLUMNS, encryptedColumnKey } from "../encrypted-columns";

const ROOT = join(__dirname, "../../../..");
const SRC = join(ROOT, "src");
const SCHEMA_PATH = join(ROOT, "prisma", "schema.prisma");

/** Prisma write methods whose argument carries a column payload. */
const WRITE_METHODS =
  "create|createMany|createManyAndReturn|update|updateMany|upsert";
/** Prisma envelope keys whose value is a payload object, not a column. */
const ENVELOPE = new Set(["data", "create", "update"]);
/** Relation-write envelopes nested inside a payload value. */
const RELATION_ENVELOPE = new Set([
  "create",
  "update",
  "upsert",
  "createMany",
  "connectOrCreate",
]);

/**
 * Columns this scan derives that are deliberately NOT in the rotation
 * registry. Empty today. An entry here is a written decision with a reason,
 * never a way to quiet the guard.
 */
const NOT_ROTATED: ReadonlySet<string> = new Set<string>();

/**
 * Ciphertext written by raw SQL, which the Prisma-call walk below cannot see.
 *
 * `DataBackup.data` is the case: the stored backup is produced as ciphertext
 * pieces (`packBackupBlobInto`) and assembled into the row by one SQL
 * statement, because holding it as one string in the process is what a large
 * record could not afford (#1031). Each entry names the file and the
 * statement, and the scan fails if the statement is no longer there, so a
 * moved or removed raw write cannot leave a stale entry that still passes.
 */
const RAW_CIPHERTEXT_WRITES: ReadonlyArray<{
  key: string;
  file: string;
  statement: RegExp;
}> = [
  {
    key: "DataBackup.data",
    file: "src/lib/export/store-backup-blob.ts",
    statement:
      /UPDATE\s+data_backups\s+SET\s+data\s*=\s*\(\s*SELECT\s+string_agg/,
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "generated" || entry === "__tests__") continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments so prose about `encrypt()` never counts as a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const callRe = (names: string[]) =>
  new RegExp(`(?<![.\\w])(?:${names.join("|")})\\s*\\(`);
/**
 * Two rules for the same identifier, and the difference matters.
 *
 * Propagation is loose: a codec builds its result through `Buffer.from(ct)` and
 * `new Uint8Array(encoded.byteLength)`, so a member read still carries the
 * taint forward or the chain snaps one hop before the return.
 *
 * The final check at a payload field is strict — the identifier must be used
 * WHOLE. `enc.expiresAt` off a tainted credentials object is a timestamp, not
 * ciphertext, and counting it would file plaintext columns as encrypted.
 */
const tokenReLoose = (names: string[]) =>
  new RegExp(`(?<![.\\w])(?:${names.join("|")})(?![\\w])`);
const tokenRe = (names: string[]) =>
  new RegExp(`(?<![.\\w])(?:${names.join("|")})(?![\\w.])`);

/** Local identifiers whose value transitively derives from a producer call. */
function taintedIdentifiers(
  body: string,
  producers: string[],
  loose: boolean,
): Set<string> {
  const assigns = [
    ...body.matchAll(/(?:const|let|var)\s+(\w+)[^;=\n]*=\s*([^;]*)/g),
  ];
  const tainted = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const before = tainted.size;
    const producerCall = callRe(producers);
    const strictToken = tainted.size ? tokenRe([...tainted]) : null;
    const looseToken = tainted.size ? tokenReLoose([...tainted]) : null;
    for (const [, name, init] of assigns) {
      if (tainted.has(name)) continue;
      if (producerCall.test(init)) {
        tainted.add(name);
        continue;
      }
      // Propagate through pure expressions only: a value awaited or read back
      // from the database is a round-trip, not ciphertext this code made.
      if (/\bawait\b|\b(?:prisma|tx|db)\./.test(init)) continue;
      // A member read normally carries no taint (`creds.expiresAt` is a
      // timestamp). The one exception is a buffer being CONSTRUCTED around a
      // ciphertext — `new Uint8Array(encoded.byteLength)` then `.set(encoded)`
      // is how every Bytes codec here builds its result, and reading the
      // length off the ciphertext is the only link the initialiser shows.
      const allowMemberRead = loose && /\bnew\s+[A-Z]|Buffer\./.test(init);
      const token = allowMemberRead ? looseToken : strictToken;
      if (token?.test(init)) tainted.add(name);
    }
    if (tainted.size === before) break;
  }
  return tainted;
}

interface Fn {
  name: string;
  body: string;
}

function declaredFunctions(src: string): Fn[] {
  const out: Fn[] = [];
  const heads = [
    ...src.matchAll(
      /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/g,
    ),
  ];
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].index! : src.length;
    out.push({ name: heads[i][1], body: src.slice(heads[i].index!, end) });
  }
  for (const m of src.matchAll(
    /(?:const|let)\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=\n]+)?=>/g,
  )) {
    // Bound the arrow at its own body. A fixed-size window instead would read
    // the code AFTER the arrow as part of it, and a tiny id-resolving helper
    // declared above a Prisma write would inherit that write's ciphertext.
    const arrow = m.index! + m[0].length;
    const brace = src.slice(arrow).search(/\S/) + arrow;
    const end =
      src[brace] === "{" ? balanced(src, brace) : endOfValue(src, brace);
    out.push({ name: m[1], body: src.slice(m.index!, end + 1) });
  }
  return out;
}

/** Fixpoint: every function that returns something derived from `encrypt`. */
function ciphertextProducers(sources: string[]): Set<string> {
  const funcs = sources.flatMap(declaredFunctions);
  const producers = new Set(["encrypt", "encryptBytes"]);
  for (let pass = 0; pass < 8; pass++) {
    const before = producers.size;
    for (const fn of funcs) {
      if (producers.has(fn.name)) continue;
      const names = [...producers];
      const tainted = taintedIdentifiers(fn.body, names, true);
      const producerCall = callRe(names);
      const taintedToken = tainted.size ? tokenReLoose([...tainted]) : null;
      const returnsCiphertext = [
        ...fn.body.matchAll(/\breturn\b([^;]*)/g),
      ].some((m) => producerCall.test(m[1]) || taintedToken?.test(m[1]));
      if (returnsCiphertext) producers.add(fn.name);
    }
    if (producers.size === before) break;
  }
  return producers;
}

// ── brace / paren walking ────────────────────────────────────────────────

/** Index of the top-level comma (or closer) ending the value starting at `i`. */
function endOfValue(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
    i++;
  }
  return i;
}

/** Index of the closer matching the opener at `i`. */
function balanced(s: string, i: number): number {
  const open = s[i];
  const close = { "(": ")", "{": "}", "[": "]" }[open]!;
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return s.length - 1;
}

/** Top-level `key: value` pairs of an object literal (braces included). */
function objectPairs(obj: string): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  let i = 1;
  while (i < obj.length - 1) {
    const m = /^[\s,]*(\w+|"[^"]*"|'[^']*')\s*:/.exec(obj.slice(i));
    if (!m) {
      const end = endOfValue(obj, i);
      if (end <= i) break;
      i = end + 1;
      continue;
    }
    const start = i + m[0].length;
    const end = endOfValue(obj, start);
    out.push([m[1].replace(/^["']|["']$/g, ""), obj.slice(start, end), start]);
    i = end + 1;
  }
  return out;
}

/** Object literals inside a payload value: `{…}`, `[{…}]`, or `map(() => ({…}))`. */
function payloadObjects(value: string): Array<[string, number]> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const at = value.indexOf(trimmed[0]);
  if (trimmed.startsWith("{")) {
    return [[value.slice(at, balanced(value, at) + 1), at]];
  }
  if (trimmed.startsWith("[")) {
    const arr = value.slice(at, balanced(value, at) + 1);
    const out: Array<[string, number]> = [];
    let i = 1;
    while (i < arr.length - 1) {
      while (i < arr.length && /[\s,]/.test(arr[i])) i++;
      if (arr[i] === "{") {
        const end = balanced(arr, i);
        out.push([arr.slice(i, end + 1), at + i]);
        i = end + 1;
      } else {
        const end = endOfValue(arr, i);
        if (end <= i) break;
        i = end + 1;
      }
    }
    return out;
  }
  const out: Array<[string, number]> = [];
  for (const m of value.matchAll(/=>\s*\(?\s*\{/g)) {
    const brace = value.indexOf("{", m.index!);
    out.push([value.slice(brace, balanced(value, brace) + 1), brace]);
  }
  return out;
}

// ── schema ───────────────────────────────────────────────────────────────

interface Schema {
  models: Set<string>;
  fieldType: Map<string, string>;
}

function parseSchema(): Schema {
  const src = readFileSync(SCHEMA_PATH, "utf8");
  const models = new Set<string>();
  const fieldType = new Map<string, string>();
  let model: string | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    const head = /^model\s+(\w+)\s*\{/.exec(line);
    if (head) {
      model = head[1];
      models.add(model);
      continue;
    }
    if (line === "}") {
      model = null;
      continue;
    }
    if (!model || line === "" || line.startsWith("//")) continue;
    const field = /^(\w+)\s+([A-Za-z]\w*)(\?|\[\])?/.exec(line);
    if (field) fieldType.set(`${model}.${field[1]}`, field[2]);
  }
  return { models, fieldType };
}

// ── the scan ─────────────────────────────────────────────────────────────

function scanCiphertextWrites(): Map<string, Set<string>> {
  const files = sourceFiles(SRC).map(
    (f) => [f, stripComments(readFileSync(f, "utf8"))] as const,
  );
  const producers = [...ciphertextProducers(files.map(([, s]) => s))];
  const schema = parseSchema();
  const found = new Map<string, Set<string>>();

  for (const [path, src] of files) {
    // The rotation machinery re-encrypts what other code wrote; it is not a
    // writer of new columns, and scanning it would fold its own generic
    // `data: { [col.field]: … }` into the result.
    if (path.includes("/lib/crypto/")) continue;
    const tainted = taintedIdentifiers(src, producers, false);
    const producerCall = callRe(producers);
    const taintedToken = tainted.size ? tokenRe([...tainted]) : null;
    const isCiphertext = (expr: string) =>
      producerCall.test(expr) || Boolean(taintedToken?.test(expr));
    const rel = path.slice(ROOT.length + 1);
    const lineAt = (idx: number) => src.slice(0, idx).split("\n").length;

    const record = (model: string, field: string, idx: number) => {
      const key = `${model}.${field}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key)!.add(`${rel}:${lineAt(idx)}`);
    };

    const descend = (
      model: string,
      value: string,
      base: number,
      depth = 0,
    ): void => {
      if (depth > 4) return;
      for (const [obj, objOffset] of payloadObjects(value)) {
        for (const [field, expr, exprOffset] of objectPairs(obj)) {
          const at = base + objOffset + exprOffset;
          const type = schema.fieldType.get(`${model}.${field}`);
          if (type && schema.models.has(type)) {
            // Relation field: the nested payload belongs to the child model.
            descend(type, expr, at, depth + 1);
            continue;
          }
          if (!type) {
            if (RELATION_ENVELOPE.has(field))
              descend(model, expr, at, depth + 1);
            continue;
          }
          if (isCiphertext(expr)) record(model, field, at);
        }
      }
    };

    const writes = new RegExp(
      `\\b(?:prisma|tx|db)\\s*\\.\\s*(\\w+)\\s*\\.\\s*(?:${WRITE_METHODS})\\s*\\(`,
      "g",
    );
    for (const raw of RAW_CIPHERTEXT_WRITES) {
      if (rel !== raw.file) continue;
      const hit = raw.statement.exec(src);
      if (hit) record(...(raw.key.split(".") as [string, string]), hit.index);
    }

    for (const m of src.matchAll(writes)) {
      const model = m[1][0].toUpperCase() + m[1].slice(1);
      if (!schema.models.has(model)) continue;
      const paren = m.index! + m[0].length - 1;
      const arg = src.slice(paren, balanced(src, paren) + 1);
      const brace = arg.indexOf("{");
      if (brace < 0) continue;
      const obj = arg.slice(brace, balanced(arg, brace) + 1);
      for (const [key, value, offset] of objectPairs(obj)) {
        if (!ENVELOPE.has(key)) continue;
        descend(model, value, paren + brace + offset);
      }
    }
  }
  return found;
}

describe("ciphertext columns derived from the code", () => {
  const producers = ciphertextProducers(
    sourceFiles(SRC).map((f) => stripComments(readFileSync(f, "utf8"))),
  );
  const written = scanCiphertextWrites();

  it("closes over the encryption wrappers, not just the two primitives", () => {
    // A closure that collapsed back to the seeds would make the write scan
    // blind to every column written through a codec helper.
    expect(producers.size).toBeGreaterThan(10);
    for (const wrapper of [
      "packBackupBlob",
      "encryptNote",
      "encryptToBytes",
      "encryptCachedBody",
    ]) {
      expect([...producers]).toContain(wrapper);
    }
  });

  it("still finds every raw-SQL ciphertext write it was told about", () => {
    for (const raw of RAW_CIPHERTEXT_WRITES) {
      expect(
        [...(written.get(raw.key) ?? [])].some((at) =>
          at.startsWith(`${raw.file}:`),
        ),
        `${raw.key}: no matching statement left in ${raw.file}`,
      ).toBe(true);
    }
  });

  it("finds ciphertext writes, including the non-suffixed columns", () => {
    // Anchored non-zero match count. An empty or collapsed result set is the
    // failure mode this whole file exists to make impossible, so name the
    // columns whose only signal is the write and not the column's name.
    expect(written.size).toBeGreaterThan(30);
    for (const anchor of [
      "DataBackup.data",
      "IdempotencyKey.responseBody",
      "NotificationChannel.config",
      "PushSubscription.p256dh",
      "IntegrationStatus.lastError",
      "WithingsConnection.accessToken",
    ]) {
      expect(
        [...written.keys()],
        `${anchor} is written with ciphertext but the scan did not see it`,
      ).toContain(anchor);
    }
  });

  it("registers every column the code writes ciphertext into", () => {
    const registered = new Set(ENCRYPTED_COLUMNS.map(encryptedColumnKey));
    const unregistered = [...written.keys()]
      .filter((key) => !registered.has(key) && !NOT_ROTATED.has(key))
      .sort()
      .map((key) => `${key} (written at ${[...written.get(key)!][0]})`);
    expect(
      unregistered,
      "columns written with AES-256-GCM ciphertext but absent from the " +
        "key-rotation registry — dropping a retired key makes these rows " +
        "permanently undecryptable",
    ).toEqual([]);
  });
});
