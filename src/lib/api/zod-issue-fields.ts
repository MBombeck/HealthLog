/**
 * The fields a sanitised Zod issue may carry beyond its path, code and
 * message, and the helpers that derive them from a raw issue without
 * echoing anything the caller sent. Used by `sanitiseZodIssues` in
 * `src/lib/api-response.ts`.
 */
import type { ZodIssue } from "zod/v4";

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
