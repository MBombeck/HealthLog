/**
 * The fields a sanitised Zod issue may carry beyond its path, code and
 * message, and the helpers that derive them from a raw issue without
 * echoing anything the caller sent. Used by `sanitiseZodIssues` in
 * `src/lib/api-response.ts`.
 */
import type { ZodIssue, ZodType } from "zod/v4";

/**
 * Sanitised view of a single Zod issue. We surface `path`, `code`,
 * `message` and — for `unrecognized_keys` only — the bounded `keys`
 * list; `issue.params` may echo the offending user input
 * (e.g. a too-long string, a regex source) and we do not want that
 * round-tripped to mobile callers or persisted into the audit ledger.
 */
export interface SanitisedZodIssue {
  path: string;
  code: string;
  message: string;
  /**
   * Only set for `unrecognized_keys`: the rejected key names, sanitised
   * and bounded by {@link sanitiseKeyName}. A key name is structure, not
   * content, so naming it is what makes the rejection actionable — the
   * caller learns which field it got wrong instead of only that the body
   * had a field too many. It survives `stripValuesFromMessage` for the
   * same reason: it carries no user-typed value.
   */
  keys?: string[];
  /**
   * Only set for `too_small` / `too_big`: the bound the schema declares
   * (a number's range, a string's or a list's length), whether it is
   * inclusive, and what it measures. These come from the schema, never
   * from the request, so naming them echoes nothing the caller sent and
   * lets a client tell the person the range instead of only "invalid".
   */
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
  origin?: string;
  /**
   * Set only when the parsed schema was known and the field declares both
   * ends: whether each end is inclusive. `minimum` and `maximum` are then
   * both present, so a client can say "allowed: 0 to 5,000" from one issue.
   * `inclusive` keeps describing the bound that was broken.
   */
  minimumInclusive?: boolean;
  maximumInclusive?: boolean;
}

/** Cap on how many rejected key names one issue reports. */
const MAX_REPORTED_KEYS = 10;
/** Cap on the length of a single reported key name. */
const MAX_KEY_NAME_LENGTH = 64;

/**
 * A key name arrives straight from the request body, so it is caller-
 * controlled and unbounded: a client can post a 100 KB key, or one
 * carrying markup, and Zod's own `unrecognized_keys` message echoes it
 * verbatim. That message reaches the client, the wide event and — at the
 * `stripValuesFromMessage` call sites — the audit ledger, so it is bounded
 * and character-restricted here rather than at each of those boundaries.
 * Anything outside `[A-Za-z0-9_.-]` collapses to `_`, which keeps a typo
 * like `measuredAtt` perfectly readable while leaving nothing that could
 * be mistaken for markup or a control sequence downstream.
 */
function sanitiseKeyName(key: string): string {
  return key.slice(0, MAX_KEY_NAME_LENGTH).replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Zod reports every unknown key of one object in a single issue whose
 * `path` is the object itself, so the offending keys live in `issue.keys`
 * and nowhere in `path`. Without this the sanitised issue read
 * `{ path: "", code: "unrecognized_keys" }` and named nothing at all.
 */
export function unrecognisedKeys(issue: ZodIssue): string[] | undefined {
  if (issue.code !== "unrecognized_keys") return undefined;
  return issue.keys.slice(0, MAX_REPORTED_KEYS).map(sanitiseKeyName);
}

/** Schema-declared bounds of a size issue; see {@link SanitisedZodIssue}. */
export function issueBounds(
  issue: ZodIssue,
): Pick<SanitisedZodIssue, "minimum" | "maximum" | "inclusive" | "origin"> {
  if (issue.code !== "too_small" && issue.code !== "too_big") return {};
  const raw = issue.code === "too_small" ? issue.minimum : issue.maximum;
  const bound = Number(raw);
  if (!Number.isFinite(bound)) return {};
  return {
    ...(issue.code === "too_small" ? { minimum: bound } : { maximum: bound }),
    ...(typeof issue.inclusive === "boolean"
      ? { inclusive: issue.inclusive }
      : {}),
    ...(typeof issue.origin === "string" ? { origin: issue.origin } : {}),
  };
}

/** One declared end of a field, read off a schema check. */
interface DeclaredBound {
  side: "minimum" | "maximum";
  value: number;
  inclusive: boolean;
}

/** Deepest schema nesting followed; a recursive `z.lazy` stops here. */
const MAX_SCHEMA_DEPTH = 32;

/** The schema's internal definition, read without its type parameters. */
type SchemaDef = {
  type?: string;
  checks?: readonly { _zod?: { def?: Record<string, unknown> } }[];
  [key: string]: unknown;
};

function defOf(node: unknown): SchemaDef | undefined {
  const zod = (node as { _zod?: { def?: SchemaDef } } | null)?._zod;
  return zod?.def;
}

/**
 * Every schema node a value at `path` may have been checked by. Wrappers
 * (optional, nullable, default, readonly, catch, pipe, lazy) are followed
 * on both sides, and a union or an intersection yields each branch: the
 * caller keeps only a node that declares the bound the issue broke, so a
 * branch that did not raise it cannot lend its bounds.
 */
function nodesAt(
  node: unknown,
  path: readonly PropertyKey[],
  depth = 0,
): unknown[] {
  if (depth > MAX_SCHEMA_DEPTH) return [];
  const def = defOf(node);
  if (!def) return [];
  const down = (next: unknown, rest = path) => nodesAt(next, rest, depth + 1);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "success":
      return [...(path.length === 0 ? [node] : []), ...down(def.innerType)];
    case "pipe":
      return [...down(def.in), ...down(def.out)];
    case "lazy":
      return typeof def.getter === "function" ? down(def.getter()) : [];
    case "union":
      return Array.isArray(def.options)
        ? def.options.flatMap((option: unknown) => down(option))
        : [];
    case "intersection":
      return [...down(def.left), ...down(def.right)];
  }
  if (path.length === 0) return [node];
  const [head, ...rest] = path;
  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, unknown> | undefined;
      const key = String(head);
      if (shape && Object.prototype.hasOwnProperty.call(shape, key)) {
        return down(shape[key], rest);
      }
      return def.catchall ? down(def.catchall, rest) : [];
    }
    case "array":
      return down(def.element, rest);
    case "tuple": {
      const items = def.items as unknown[] | undefined;
      const index = Number(head);
      if (items && Number.isInteger(index) && index < items.length) {
        return down(items[index], rest);
      }
      return def.rest ? down(def.rest, rest) : [];
    }
    case "record":
    case "map":
      return down(def.valueType, rest);
    case "set":
      return down(def.valueType, rest);
    default:
      return [];
  }
}

/** The ends a node declares through its own checks. */
function declaredBounds(node: unknown): DeclaredBound[] {
  const out: DeclaredBound[] = [];
  for (const check of defOf(node)?.checks ?? []) {
    const def = check._zod?.def;
    if (!def) continue;
    const raw = def.value;
    const numeric =
      raw instanceof Date ? raw.getTime() : typeof raw === "number" ? raw : NaN;
    switch (def.check) {
      case "less_than":
        if (Number.isFinite(numeric)) {
          out.push({
            side: "maximum",
            value: numeric,
            inclusive: def.inclusive === true,
          });
        }
        break;
      case "greater_than":
        if (Number.isFinite(numeric)) {
          out.push({
            side: "minimum",
            value: numeric,
            inclusive: def.inclusive === true,
          });
        }
        break;
      case "max_length":
      case "max_size":
        if (typeof def.maximum === "number") {
          out.push({ side: "maximum", value: def.maximum, inclusive: true });
        }
        break;
      case "min_length":
      case "min_size":
        if (typeof def.minimum === "number") {
          out.push({ side: "minimum", value: def.minimum, inclusive: true });
        }
        break;
    }
  }
  return out;
}

/** The tightest declared end of one side (a later `.max()` may narrow). */
function tightest(
  bounds: readonly DeclaredBound[],
  side: DeclaredBound["side"],
): DeclaredBound | undefined {
  let best: DeclaredBound | undefined;
  for (const b of bounds) {
    if (b.side !== side) continue;
    if (
      !best ||
      (side === "maximum" ? b.value < best.value : b.value > best.value) ||
      (b.value === best.value && !b.inclusive)
    ) {
      best = b;
    }
  }
  return best;
}

/**
 * {@link issueBounds}, and when the parsed schema is known and the field
 * declares the other end too, that end as well: a `too_big` issue on
 * `z.number().min(0).max(5000)` carries `minimum: 0` beside `maximum: 5000`.
 *
 * Generic: the field's node is found by walking the schema along the
 * issue's path, never by a per-route table. The other end is added only
 * when that node declares the very bound the issue reports, so a union
 * branch, an exact length or a refinement that reused the code adds
 * nothing. Both ends come from the schema, not from the request.
 */
export function issueBoundsWithSchema(
  issue: ZodIssue,
  schema: ZodType | undefined,
): Pick<
  SanitisedZodIssue,
  | "minimum"
  | "maximum"
  | "inclusive"
  | "origin"
  | "minimumInclusive"
  | "maximumInclusive"
> {
  const base = issueBounds(issue);
  if (!schema) return base;
  if (issue.code !== "too_small" && issue.code !== "too_big") return base;
  if ("exact" in issue && issue.exact === true) return base;
  const brokenSide = issue.code === "too_small" ? "minimum" : "maximum";
  const brokenValue = base[brokenSide];
  if (brokenValue === undefined) return base;
  const otherSide = brokenSide === "minimum" ? "maximum" : "minimum";
  for (const node of nodesAt(schema, issue.path)) {
    const bounds = declaredBounds(node);
    const declaresBroken = bounds.some(
      (b) =>
        b.side === brokenSide &&
        b.value === brokenValue &&
        b.inclusive === (base.inclusive ?? b.inclusive),
    );
    if (!declaresBroken) continue;
    const other = tightest(bounds, otherSide);
    if (!other) return base;
    return {
      ...base,
      [otherSide]: other.value,
      [`${brokenSide}Inclusive`]: base.inclusive ?? true,
      [`${otherSide}Inclusive`]: other.inclusive,
    };
  }
  return base;
}

/**
 * Rebuilt from the sanitised key names rather than passed through from
 * Zod, so the wording stays the one callers already parse while the
 * unbounded verbatim echo does not ship.
 */
export function unrecognisedKeysMessage(keys: string[]): string {
  const rendered = keys.map((key) => `"${key}"`).join(", ");
  return keys.length === 1
    ? `Unrecognized key: ${rendered}`
    : `Unrecognized keys: ${rendered}`;
}
