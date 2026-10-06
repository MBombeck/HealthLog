/**
 * v1.39.4 — the Coach composer's id, and handing focus to it.
 *
 * A reply pill (a follow-up, a clarifying choice, a memory or plan
 * decision) sends a message and then goes away (pills hide while the turn
 * runs), which would drop keyboard and screen-reader focus to the page. Focus moves to the composer
 * instead: that is where the person continues. The composer stays focusable
 * while a reply streams (it is read-only then, not disabled).
 */
export const COACH_COMPOSER_ID = "coach-composer-textarea";

export function focusCoachComposer(): void {
  if (typeof document === "undefined") return;
  document.getElementById(COACH_COMPOSER_ID)?.focus();
}
