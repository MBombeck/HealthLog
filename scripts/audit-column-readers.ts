/**
 * Release-battery sweep: which Prisma columns have no consumer, and which have
 * no writer at all?
 *
 * Run it as part of the deep-audit step, not in CI:
 *
 *     pnpm dlx tsx scripts/audit-column-readers.ts
 *     pnpm dlx tsx scripts/audit-column-readers.ts --model Measurement
 *     pnpm dlx tsx scripts/audit-column-readers.ts --all
 *
 * ## Why this is a script and not a test
 *
 * The question "does this column have a consumer anywhere in the tree" is a
 * whole-program property, and the only cheap way to approximate it is to read
 * the source without type information. That approximation is unsound in both
 * directions. Generic field names (`value`, `type`, `state`, `source`) match
 * unrelated identifiers and read as consumed when they are not. Consumption
 * through a select-less `findUnique` plus whole-row serialization reads as
 * unconsumed when it is not. Dynamic selects fall outside the matcher.
 *
 * A gate built on that matcher would drift towards green and stop meaning
 * anything, which is exactly the failure this whole family of guards exists to
 * prevent — a pair guard that quietly degrades into a one-end guard is worse
 * than no guard, because it also removes the suspicion. So this stays a review
 * tool with a human reading the output. The two questions that CAN be answered
 * exactly — is every account-payload field consumed, is every Measurement
 * column backed up — are tests instead:
 * `src/__tests__/account-payload-consumer-guard.test.ts` and
 * `src/__tests__/measurement-backup-completeness.test.ts`.
 *
 * ## What the matcher does, and where it stops
 *
 * Each file is masked once (comments, string bodies and regex literals blanked
 * in place, `${…}` substitutions kept as code because `` `${row.field}` `` is a
 * real read). Every `<key>: {` / `<key>: [` block is then bracket-matched and
 * the characters inside it are tagged with the role that key gives them:
 *
 *   - write   — `data` `create` `createMany` `update` `updateMany` `upsert`
 *               `set` `connectOrCreate`
 *   - project — `select` `include` (a projection IS a read of the column)
 *   - query   — `where` `orderBy` `cursor` `distinct` `having` `by` `omit`
 *
 * Nesting resolves innermost-wins, so the `where` inside an `upsert` is a
 * query and the `data` beside it is a write. That distinction is the whole
 * point of the rewrite: the previous matcher counted every `<field>:` key
 * anywhere as a write, so a column that is only ever FILTERED ON looked
 * written-but-unread. All twelve findings it reported were that one mistake.
 *
 * Known limits, stated plainly so nobody mistakes a clean run for a proof:
 *
 *   - Counts are per identifier, not per model. Two models with a `lastSeenAt`
 *     share one tally, so a read of either satisfies both. This is the same
 *     imprecision `GENERIC_NAMES` exists for, and it applies to every name.
 *   - `obj.field = …` counts as a write even when `obj` never reaches the
 *     database. Without it the settings layer, which assembles its update
 *     objects field by field, reads as columns nothing writes.
 *   - A non-Prisma object literal under a `data:` key (a chart series, a
 *     react-query result) is counted as a write.
 *   - A payload returned by a helper rather than declared beside its Prisma
 *     call is still invisible; the dataflow pass is one hop and one file.
 *   - Raw SQL is classified by keyword only: a literal shaped like INSERT or
 *     UPDATE…SET donates writes, one shaped like SELECT…FROM donates reads,
 *     for both the field name and its `@map` column name.
 *   - Relation attributes are read one line at a time; a `@relation(…)` split
 *     across lines would not register its `fields: […]`.
 *
 * ## The annotation convention
 *
 * A pull request that adds a column, payload field, or preference contains its
 * consumer. When it genuinely cannot, the schema comment says so and this
 * sweep treats the marker as an expiring allowlist entry:
 *
 *     /// @pending-consumer(#123) — iOS reads this from v1.33; server-side unread until then.
 *     /// @internal: cooldown bookkeeping for the reminder cron; never surfaced.
 *
 * `@internal` is permanent and silences the field. `@pending-consumer` is
 * temporary: the field stays out of the findings list but is reported
 * separately every run, so an issue that closed without the consumer landing
 * becomes visible at the next release audit instead of never.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
/**
 * `src` is the application; `scripts` holds the one-shot maintenance tools,
 * which are the other place a column legitimately gets written or read. Tests
 * are excluded on purpose — a fixture is not a consumer.
 */
const SCAN_DIRS = ["src", "scripts"];

/** `generated` is the Prisma client: megabytes of noise, and never a consumer. */
const SKIP_DIRS = new Set([
  "generated",
  "node_modules",
  ".next",
  "__tests__",
  "__mocks__",
]);

/**
 * Names too generic for the matcher to say anything useful about. Reported in
 * their own section rather than dropped, so the sweep never claims a clean
 * bill it cannot back up. The suppression covers the consumer question only:
 * a name that appears NOWHERE in the tree is still unwired, and that verdict
 * does not get less true for a column called `state`.
 */
const GENERIC_NAMES = new Set([
  "id",
  "name",
  "type",
  "value",
  "unit",
  "source",
  "state",
  "status",
  "label",
  "kind",
  "data",
  "key",
  "code",
  "url",
  "title",
  "notes",
  "userId",
  "createdAt",
  "updatedAt",
  "deletedAt",
]);

export interface Field {
  model: string;
  name: string;
  /** `@map("…")` target, or the field name when it maps to itself. */
  column: string;
  annotation: "internal" | "pending-consumer" | null;
  annotationText: string | null;
  /** `@default(…)`, `@updatedAt` or `@id`: the database fills it unaided. */
  dbManaged: boolean;
  /** Relation properties that carry this scalar in their `fields: […]`. */
  relationBacked: string[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function parseSchema(schema: string): Field[] {
  const models = new Set(
    [...schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)].map((m) => m[1]),
  );
  const fields: Field[] = [];

  for (const model of models) {
    const start = schema.indexOf(`model ${model} {`);
    if (start === -1) continue;
    const end = schema.indexOf("\n}", start);
    const lines = schema.slice(start, end).split("\n").slice(1);

    const scalars: Field[] = [];
    /** scalar field name → relation properties that carry it. */
    const carriedBy = new Map<string, string[]>();

    let pending: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("//")) {
        pending.push(line);
        continue;
      }
      if (line.startsWith("@@")) {
        pending = [];
        continue;
      }
      const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
      if (!m) {
        pending = [];
        continue;
      }
      const [, name, type, isList] = m;

      if (isList || models.has(type) || line.includes("@relation")) {
        const carrier = /@relation\([^)]*\bfields:\s*\[([^\]]*)\]/.exec(line);
        if (carrier) {
          for (const raw of carrier[1].split(",")) {
            const scalar = raw.trim();
            if (!scalar) continue;
            carriedBy.set(scalar, [...(carriedBy.get(scalar) ?? []), name]);
          }
        }
        pending = [];
        continue;
      }

      // Doc comments come in as `/// …` lines above the field, plus any
      // trailing `// …` on the field line itself. Strip the markers and the
      // declaration before reading an annotation out of them, or the reported
      // reason comes back with the column's own Prisma type glued to its end.
      const trailing = line.includes("//")
        ? line.slice(line.indexOf("//"))
        : "";
      const comment = [...pending, trailing]
        .map((l) => l.replace(/^\/{2,3}\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
      let annotation: Field["annotation"] = null;
      let annotationText: string | null = null;
      const internal = /@internal:?\s*(.*)$/.exec(comment);
      const pendingConsumer = /@pending-consumer\(([^)]*)\)\s*(.*)$/.exec(
        comment,
      );
      if (pendingConsumer) {
        annotation = "pending-consumer";
        annotationText = `${pendingConsumer[1]} ${pendingConsumer[2]}`.trim();
      } else if (internal) {
        annotation = "internal";
        annotationText = internal[1].trim();
      }

      const mapped = /@map\(\s*"([^"]*)"\s*\)/.exec(line);
      scalars.push({
        model,
        name,
        column: mapped ? mapped[1] : name,
        annotation,
        annotationText,
        dbManaged:
          line.includes("@default(") ||
          line.includes("@updatedAt") ||
          /(?<![\w@])@id\b/.test(line),
        relationBacked: [],
      });
      pending = [];
    }

    for (const field of scalars) {
      field.relationBacked = carriedBy.get(field.name) ?? [];
      fields.push(field);
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
  "\n",
]);

export interface Masked {
  /** Same length as the input; comments, string bodies and regexes blanked. */
  masked: string;
  /** Every string and template chunk body, for the raw-SQL pass. */
  literals: string[];
}

/**
 * Blank everything that is not code, preserving offsets so the later
 * bracket-match lines up with the original text. A template substitution stays
 * code: its `${` and matching `}` are blanked as a pair so brackets still
 * balance, and the expression between them is left alone.
 */
export function maskLiterals(src: string): Masked {
  const out = src.split("");
  const literals: string[] = [];
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };

  /** Bottom frame is the file itself; each `` ` `` and `${` pushes one. */
  const stack: Array<{ tpl: boolean; depth: number }> = [
    { tpl: false, depth: 0 },
  ];
  let i = 0;
  let lastSig = "\n";

  while (i < n) {
    const frame = stack[stack.length - 1];
    const c = src[i];

    if (frame.tpl) {
      if (c === "\\") {
        blank(i, Math.min(i + 2, n));
        i += 2;
        continue;
      }
      if (c === "`") {
        out[i] = " ";
        stack.pop();
        i += 1;
        lastSig = '"';
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(i, i + 2);
        stack.push({ tpl: false, depth: 0 });
        i += 2;
        lastSig = "(";
        continue;
      }
      let end = i;
      while (
        end < n &&
        src[end] !== "\\" &&
        src[end] !== "`" &&
        !(src[end] === "$" && src[end + 1] === "{")
      )
        end++;
      literals.push(src.slice(i, end));
      blank(i, end);
      i = end;
      continue;
    }

    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let end = i + 1;
      while (end < n && src[end] !== c && src[end] !== "\n") {
        if (src[end] === "\\") end++;
        end++;
      }
      literals.push(src.slice(i + 1, end));
      blank(i, Math.min(end + 1, n));
      i = Math.min(end + 1, n);
      lastSig = '"';
      continue;
    }
    if (c === "`") {
      out[i] = " ";
      stack.push({ tpl: true, depth: 0 });
      i += 1;
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.has(lastSig)) {
      let end = i + 1;
      let inClass = false;
      let closed = false;
      while (end < n && src[end] !== "\n") {
        const d = src[end];
        if (d === "\\") {
          end += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          end++;
          closed = true;
          break;
        }
        end++;
      }
      if (closed) {
        while (end < n && /[a-z]/.test(src[end])) end++;
        blank(i, end);
        i = end;
        lastSig = '"';
        continue;
      }
      // Never closed before the newline: it was a division after all.
    }
    if (c === "{") frame.depth++;
    else if (c === "}") {
      if (frame.depth === 0 && stack.length > 1) {
        out[i] = " ";
        stack.pop();
        i += 1;
        lastSig = '"';
        continue;
      }
      frame.depth--;
    }
    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }

  return { masked: out.join(""), literals };
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLE_NONE = 0;
export const ROLE_WRITE = 1;
export const ROLE_PROJECT = 2;
export const ROLE_QUERY = 3;

const ROLE_KEYS: Record<string, number> = {
  data: ROLE_WRITE,
  create: ROLE_WRITE,
  createMany: ROLE_WRITE,
  update: ROLE_WRITE,
  updateMany: ROLE_WRITE,
  upsert: ROLE_WRITE,
  set: ROLE_WRITE,
  connectOrCreate: ROLE_WRITE,
  select: ROLE_PROJECT,
  include: ROLE_PROJECT,
  where: ROLE_QUERY,
  orderBy: ROLE_QUERY,
  cursor: ROLE_QUERY,
  distinct: ROLE_QUERY,
  having: ROLE_QUERY,
  by: ROLE_QUERY,
  omit: ROLE_QUERY,
};

const ROLE_KEY_RE = new RegExp(
  `(?<![\\w$.])(${Object.keys(ROLE_KEYS).join("|")})\\s*:`,
  "g",
);

/** A `data:` payload is rarely longer than this; a runaway scan is a bug. */
const EXTENT_CAP = 20_000;

/**
 * The end of the expression that starts at `from`: the next `,` or closing
 * bracket at nesting depth zero. Scanning the expression rather than
 * bracket-matching a leading `{` is what lets
 * `createMany({ data: ids.map((id) => ({ … })) })` register as a write.
 */
function expressionExtent(text: string, from: number): number {
  let depth = 0;
  const limit = Math.min(text.length, from + EXTENT_CAP);
  for (let i = from; i < limit; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i;
  }
  return limit;
}

/** The extent of a call's argument list, given the index of its `(`. */
function callArguments(text: string, open: number): [number, number] {
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + EXTENT_CAP); i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return [open, i];
    }
  }
  return [open, Math.min(text.length - 1, open + EXTENT_CAP)];
}

const WRITE_KEY_NAMES = Object.keys(ROLE_KEYS).filter(
  (k) => ROLE_KEYS[k] === ROLE_WRITE,
);
/** `update: data` / `data: rows` — a payload handed over by name. */
const WRITE_VALUE_RE = new RegExp(
  `(?<![\\w$.])(?:${WRITE_KEY_NAMES.join("|")})\\s*:\\s*([A-Za-z_$][\\w$]*)(?![\\w$(])`,
  "g",
);
/** `create: { ...data }` — a payload merged in. */
const SPREAD_RE = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;
/** `const rows: Prisma.WorkoutCreateManyInput[] = []` — a payload by its type. */
const TYPED_PAYLOAD_RE =
  /(?<![\w$])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*Prisma\.\w*(?:Create|Update|Upsert)\w*Input/g;

function paint(masked: string, spans: Array<[number, number, number]>) {
  const roles = new Uint8Array(masked.length);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [from, to, role] of spans) roles.fill(role, from, to);
  return roles;
}

/**
 * Tag every character with the role of the innermost `<key>: …` value that
 * encloses it. Outer values are painted first and inner ones paint over them,
 * which is what makes `upsert: { where: {…}, create: {…} }` come out right.
 *
 * A second pass then follows payloads assembled before the call: a
 * `const data = {…}` handed to `update:`, a `{ …spread }` merged into a
 * `create:`, and the `rows.push({…})` builders that fill an array typed
 * `Prisma.…Input[]`. All three are house style here — the no-mass-assignment
 * rule makes field-by-field builders the norm — and without this pass most of
 * the settings and import layer reads as columns nothing ever writes.
 */
export function roleMap(masked: string): Uint8Array {
  const spans: Array<[number, number, number]> = [];
  for (const m of masked.matchAll(ROLE_KEY_RE)) {
    let from = m.index + m[0].length;
    while (from < masked.length && /\s/.test(masked[from])) from++;
    spans.push([from, expressionExtent(masked, from), ROLE_KEYS[m[1]]]);
  }

  const roles = paint(masked, spans);
  const sinks = new Set<string>();
  for (const m of masked.matchAll(WRITE_VALUE_RE)) sinks.add(m[1]);
  for (const m of masked.matchAll(TYPED_PAYLOAD_RE)) sinks.add(m[1]);
  for (const m of masked.matchAll(SPREAD_RE))
    // The identifier ends the match, so its offset is the match's end minus
    // its own length. The `d` flag would say this directly, but it is above
    // the target this project compiles to.
    if (roles[m.index + m[0].length - m[1].length] === ROLE_WRITE)
      sinks.add(m[1]);

  for (const ident of sinks) {
    const decl = new RegExp(
      `(?<![\\w$])(?:const|let|var)\\s+${ident}(?![\\w$])\\s*(?::[^=;]*)?=\\s*`,
      "g",
    );
    for (const m of masked.matchAll(decl)) {
      const from = m.index + m[0].length;
      spans.push([from, expressionExtent(masked, from), ROLE_WRITE]);
    }
    const push = new RegExp(`(?<![\\w$])${ident}\\s*\\.\\s*push\\s*\\(`, "g");
    for (const m of masked.matchAll(push)) {
      const [open, close] = callArguments(masked, m.index + m[0].length - 1);
      spans.push([open, close, ROLE_WRITE]);
    }
  }

  return paint(masked, spans);
}

// ---------------------------------------------------------------------------
// Usage index
// ---------------------------------------------------------------------------

type Tally = Map<string, number>;

const bump = (t: Tally, k: string) => t.set(k, (t.get(k) ?? 0) + 1);

/**
 * Per-identifier counts, gathered in four passes over the whole tree rather
 * than one pass per column: the schema has ~1500 scalars and re-scanning
 * megabytes for each of them turns a review tool into a coffee break.
 */
export interface SourceIndex {
  /** Keys and shorthand inside write payloads, plus `payload.field =` assignment. */
  writeKeys: Tally;
  /** Keys inside `select` / `include` projections. */
  projectKeys: Tally;
  /** Keys and shorthand inside filters and orderings. */
  queryKeys: Tally;
  /** Shorthand destructuring that no Prisma argument claims. */
  plainShorthand: Tally;
  /** `.field` property access, wherever it happens. */
  access: Tally;
  /** Every identifier in code, plus every word in a string literal. */
  mentions: Tally;
  /** Words inside INSERT / UPDATE…SET literals. */
  sqlWrite: Tally;
  /** Words inside SELECT…FROM literals. */
  sqlRead: Tally;
}

export function emptyIndex(): SourceIndex {
  return {
    writeKeys: new Map(),
    projectKeys: new Map(),
    queryKeys: new Map(),
    plainShorthand: new Map(),
    access: new Map(),
    mentions: new Map(),
    sqlWrite: new Map(),
    sqlRead: new Map(),
  };
}

const KEY_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*:/g;
const SHORTHAND_RE = /[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g;
const ACCESS_RE = /\.\s*([A-Za-z_$][\w$]*)(?![\w$])(?!\s*=(?!=))/g;
/**
 * `updates.aiLocalBaseUrl = null` — a payload assembled into a variable before the
 * Prisma call. Without this the whole settings layer, which builds its update
 * objects field by field precisely so it cannot mass-assign, reads as a tree
 * full of columns nothing ever writes.
 */
const ASSIGN_RE = /\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
const IDENT_RE = /(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])/g;
const WORD_RE = /[A-Za-z_][\w$]*/g;

/** A literal that writes columns, one that reads them, or neither. */
function sqlShape(literal: string): "write" | "read" | null {
  if (/\binsert\s+into\b/i.test(literal)) return "write";
  if (/\bupdate\b[\s\S]{0,200}?\bset\b/i.test(literal)) return "write";
  if (/\bselect\b[\s\S]{0,400}?\bfrom\b/i.test(literal)) return "read";
  return null;
}

export function indexSource(src: string, into = emptyIndex()): SourceIndex {
  const { masked, literals } = maskLiterals(src);
  const roles = roleMap(masked);

  for (const m of masked.matchAll(KEY_RE)) {
    // The lookbehind is zero-width, so the key starts the match.
    const at = m.index;
    if (roles[at] === ROLE_WRITE) bump(into.writeKeys, m[1]);
    else if (roles[at] === ROLE_PROJECT) bump(into.projectKeys, m[1]);
    else if (roles[at] === ROLE_QUERY) bump(into.queryKeys, m[1]);
  }
  for (const m of masked.matchAll(SHORTHAND_RE)) {
    // Only a brace or comma and whitespace precede the identifier.
    const at = m.index + m[0].indexOf(m[1], 1);
    if (roles[at] === ROLE_WRITE) bump(into.writeKeys, m[1]);
    else if (roles[at] === ROLE_QUERY) bump(into.queryKeys, m[1]);
    else if (roles[at] === ROLE_NONE) bump(into.plainShorthand, m[1]);
  }
  for (const m of masked.matchAll(ACCESS_RE)) bump(into.access, m[1]);
  for (const m of masked.matchAll(ASSIGN_RE)) bump(into.writeKeys, m[1]);
  for (const m of masked.matchAll(IDENT_RE)) bump(into.mentions, m[1]);

  for (const literal of literals) {
    const shape = sqlShape(literal);
    for (const word of literal.match(WORD_RE) ?? []) {
      // A column named in ANY literal counts as mentioned, so the
      // "appears nowhere" verdict stays the strictest thing this tool says.
      bump(into.mentions, word);
      if (shape === "write") bump(into.sqlWrite, word);
      else if (shape === "read") bump(into.sqlRead, word);
    }
  }

  return into;
}

export interface Usage {
  writes: number;
  /** `select: { field: true }`, `.field`, plain destructuring, SELECT column. */
  reads: number;
  /** Filtered or ordered on: the column drives a query but never lands in JS. */
  queryUses: number;
  /** Any appearance at all, in code or in a literal — the unwired test. */
  mentions: number;
}

export function countUsage(index: SourceIndex, field: Field): Usage {
  const get = (t: Tally, k: string) => t.get(k) ?? 0;
  const both = (t: Tally) =>
    get(t, field.name) +
    (field.column === field.name ? 0 : get(t, field.column));

  return {
    writes: get(index.writeKeys, field.name) + both(index.sqlWrite),
    reads:
      get(index.projectKeys, field.name) +
      get(index.access, field.name) +
      get(index.plainShorthand, field.name) +
      both(index.sqlRead),
    queryUses: get(index.queryKeys, field.name),
    mentions: both(index.mentions),
  };
}

export type Category =
  | "annotated-internal"
  | "annotated-pending"
  | "relation-backed"
  | "unwired"
  | "write-no-reader"
  | "query-only"
  | "read-no-writer"
  | "generic"
  | "consumed";

/**
 * One column, one verdict. The order matters. An annotation is the maintainer
 * speaking and outranks the matcher. `unwired` comes next because it is the
 * only verdict here that does not depend on how the source is shaped — the
 * identifier is simply absent — so neither a generic name nor a relation can
 * excuse it.
 */
export function categorise(field: Field, usage: Usage): Category {
  if (field.annotation === "internal") return "annotated-internal";
  if (field.annotation === "pending-consumer") return "annotated-pending";
  if (usage.mentions === 0) return "unwired";
  // Prisma writes the FK when the caller connects the relation, and reads it
  // back when the caller selects the relation. Neither shows up under the
  // scalar's own name, so the matcher cannot judge these at all.
  if (field.relationBacked.length > 0) return "relation-backed";
  if (GENERIC_NAMES.has(field.name)) return "generic";
  if (usage.writes === 0) {
    // `@default(…)` / `@updatedAt` / `@id`: the database is the writer.
    if (field.dbManaged) return "consumed";
    return usage.reads > 0 || usage.queryUses > 0
      ? "read-no-writer"
      : "unwired";
  }
  if (usage.reads > 0) return "consumed";
  return usage.queryUses > 0 ? "query-only" : "write-no-reader";
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const modelFilter = args.includes("--model")
    ? args[args.indexOf("--model") + 1]
    : null;
  const showAll = args.includes("--all");

  const fields = parseSchema(readFileSync(SCHEMA, "utf8")).filter(
    (f) => !modelFilter || f.model === modelFilter,
  );
  const index = emptyIndex();
  for (const dir of SCAN_DIRS)
    for (const file of walk(join(ROOT, dir)))
      indexSource(readFileSync(file, "utf8"), index);

  const buckets = new Map<Category, Array<Field & Usage>>();
  for (const field of fields) {
    const usage = countUsage(index, field);
    const category = categorise(field, usage);
    buckets.set(category, [
      ...(buckets.get(category) ?? []),
      { ...field, ...usage },
    ]);
  }
  const bucket = (c: Category) => buckets.get(c) ?? [];

  const scope = modelFilter ? `model ${modelFilter}` : "every model";
  console.log(
    `Column-reader sweep over ${scope} — ${fields.length} scalar column(s) ` +
      `against ${SCAN_DIRS.join(" + ")}.\n`,
  );

  const section = (
    title: string,
    rows: Array<Field & Usage>,
    line: (f: Field & Usage) => string,
  ) => {
    if (rows.length === 0) return;
    console.log(`## ${title} — ${rows.length}\n`);
    for (const f of rows) console.log(`  ${f.model}.${f.name}  ${line(f)}`);
    console.log("");
  };

  section(
    "Written, and nothing anywhere consumes it",
    bucket("write-no-reader"),
    (f) => `(writes: ${f.writes})`,
  );
  section(
    "Neither written nor read — nothing in the tree wires this column",
    bucket("unwired"),
    (f) => `(column "${f.column}", mentions: ${f.mentions})`,
  );
  section(
    "Consumed only by a query clause — filtered or ordered on, never carried into JavaScript",
    bucket("query-only"),
    (f) => `(writes: ${f.writes}, query uses: ${f.queryUses})`,
  );
  section(
    "Read but never written by application code",
    bucket("read-no-writer"),
    (f) => `(reads: ${f.reads}, query uses: ${f.queryUses})`,
  );
  section(
    "Marked @pending-consumer — check whether the issue closed without the consumer landing",
    bucket("annotated-pending"),
    (f) => f.annotationText ?? "",
  );

  if (showAll) {
    section(
      "Marked @internal — permanently silenced, listed for review",
      bucket("annotated-internal"),
      (f) => f.annotationText ?? "",
    );
    section(
      "Suppressed: name too generic for the matcher to judge",
      bucket("generic"),
      (f) => `(writes: ${f.writes}, reads: ${f.reads})`,
    );
    section(
      "Carried by a relation — Prisma writes and reads these under the relation's name",
      bucket("relation-backed"),
      (f) => `(via ${f.relationBacked.join(", ")})`,
    );
  }

  const quiet: Category[] = [
    "consumed",
    "relation-backed",
    "annotated-internal",
    "generic",
  ];
  console.log(
    "Not listed: " +
      quiet.map((c) => `${bucket(c).length} ${c}`).join(", ") +
      (showAll ? "" : " (re-run with --all to see the last three)"),
  );
  console.log(
    "\nEvery finding above needs a human. Counts are per identifier rather than\n" +
      "per model, whole-row serialization reads as unconsumed, and a non-Prisma\n" +
      "`data:` literal reads as a write.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
