/**
 * Whether the operator's bucket retires old copies by itself, read from its
 * lifecycle rules (`GetBucketLifecycleConfiguration`).
 *
 * Two answers, because the bucket holds two kinds of object with different
 * keys: the per-account copies (`<date>/user-<id>.json.enc`) and the database
 * dumps (`database/…`). A rule scoped to a prefix covers only the keys under
 * it, so a bucket whose one rule expires `2026-` keys ages the account copies
 * out and keeps every database dump forever, and a database dump keeps every
 * deleted account's data for as long as it exists. The account answer keeps
 * its earlier reading (the shortest expiry of any enabled rule); the database
 * answer counts only the rules that apply to a key under `database/`.
 *
 * `configured` names the shortest expiry; `missing` means the bucket answered
 * that no rule applies; `unknown` means it would not say (a credential
 * without `s3:GetLifecycleConfiguration`, a target that does not implement the
 * call, a network failure) and says nothing either way.
 */
import type { LifecycleRule } from "@aws-sdk/client-s3";

export interface LifecycleVerdict {
  state: "configured" | "missing" | "unknown";
  expirationDays: number | null;
}

export interface OffhostLifecycle extends LifecycleVerdict {
  /** The same question for the database dumps under `database/`. */
  database: LifecycleVerdict;
}

export const LIFECYCLE_UNKNOWN: OffhostLifecycle = {
  state: "unknown",
  expirationDays: null,
  database: { state: "unknown", expirationDays: null },
};

export const LIFECYCLE_MISSING: OffhostLifecycle = {
  state: "missing",
  expirationDays: null,
  database: { state: "missing", expirationDays: null },
};

/** A key a database dump is stored under, to test the rules against. */
const DATABASE_SAMPLE_KEY =
  "database/healthlog-20260101T013000Z-daily.dump.enc";

/**
 * Whether a rule's filter takes in `key`. Our objects carry no tags, so a
 * rule that filters on a tag never applies to them; a size bound is not a
 * reason to call a rule inapplicable, so it is read as applying.
 */
export function ruleAppliesTo(rule: LifecycleRule, key: string): boolean {
  const filter = rule.Filter;
  if (filter?.Tag || filter?.And?.Tags?.length) return false;
  const prefix = filter?.Prefix ?? filter?.And?.Prefix ?? rule.Prefix ?? "";
  return key.startsWith(prefix);
}

function verdict(rules: readonly LifecycleRule[]): LifecycleVerdict {
  const days = rules
    .filter((rule) => rule.Status === "Enabled")
    .map((rule) => rule.Expiration?.Days)
    .filter((d): d is number => typeof d === "number" && d > 0);
  return days.length > 0
    ? { state: "configured", expirationDays: Math.min(...days) }
    : { state: "missing", expirationDays: null };
}

/** Both answers from the rules a bucket returned. */
export function lifecycleFromRules(
  rules: readonly LifecycleRule[],
): OffhostLifecycle {
  return {
    ...verdict(rules),
    database: verdict(
      rules.filter((rule) => ruleAppliesTo(rule, DATABASE_SAMPLE_KEY)),
    ),
  };
}
