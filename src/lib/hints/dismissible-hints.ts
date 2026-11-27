/**
 * Every one-time hint, note and banner a person can put away, and the one
 * place their dismissal lives: `User.dismissedHints`, published on
 * `/api/auth/me` as `dismissedHints` and written through
 * `PATCH /api/auth/me/dismissed-hints`.
 *
 * A dismissal used to sit in the browser's local storage, one key per hint.
 * That forgot itself on every other device, in a second browser, and whenever
 * the browser evicted the site's storage (an installed web app on iOS loses it
 * after a week without use), so a hint the person had closed came back. Stored
 * on the account, closed means closed everywhere.
 *
 * An id is a family from `DISMISSIBLE_HINTS`, optionally followed by `.` and
 * a member: the machine-translation banner is dismissed per language
 * (`i18n-banner.fr`), the getting-started checklist per row
 * (`getting-started.add-measurement`). Restoring a family restores its
 * members too. Client-safe: no server imports.
 */

export const DISMISSIBLE_HINTS = [
  /** The timeline's readiness card: what the timeline carries, and its gaps. */
  "timeline-readiness",
  /** The one hint that AI could be set up (Insights overview, Settings → AI). */
  "ai-setup",
  /** The AI consent request tile on the Insights overview. */
  "ai-consent-request",
  /** The note on the correlation surface after the seasonal adjustment. */
  "correlation-seasonal",
  /** The machine-translation banner, per language. */
  "i18n-banner",
  /** The getting-started checklist: the whole card, or one row of it. */
  "getting-started",
] as const;

export type DismissibleHint = (typeof DISMISSIBLE_HINTS)[number];

/** Most ids one account keeps; the oldest fall away beyond it. */
export const DISMISSED_HINTS_MAX = 200;

const MEMBER = /^[A-Za-z0-9:_-]{1,64}$/;

/** `family` or `family.member`. */
export function hintId(family: DismissibleHint, member?: string): string {
  return member === undefined ? family : `${family}.${member}`;
}

/** Whether `id` names a registered hint (a family, or one of its members). */
export function isDismissibleHintId(id: string): boolean {
  const dot = id.indexOf(".");
  const family = dot === -1 ? id : id.slice(0, dot);
  if (!(DISMISSIBLE_HINTS as readonly string[]).includes(family)) return false;
  return dot === -1 || MEMBER.test(id.slice(dot + 1));
}

/** Whether `restoreId` restores `stored`: the id itself, or a member of it. */
function restores(restoreId: string, stored: string): boolean {
  return stored === restoreId || stored.startsWith(`${restoreId}.`);
}

/**
 * The next stored list: `restore` removed (a family takes its members with
 * it), `dismiss` added once each, newest last, capped at
 * `DISMISSED_HINTS_MAX`. Pure, so the route and the client's optimistic
 * update compute the same list.
 */
export function nextDismissedHints(
  current: readonly string[],
  change: { dismiss?: readonly string[]; restore?: readonly string[] },
): string[] {
  const restore = change.restore ?? [];
  const kept = current.filter((id) => !restore.some((r) => restores(r, id)));
  for (const id of change.dismiss ?? []) {
    if (!kept.includes(id)) kept.push(id);
  }
  return kept.slice(-DISMISSED_HINTS_MAX);
}
