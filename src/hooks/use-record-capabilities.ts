"use client";

import { useAuth } from "@/hooks/use-auth";
import {
  accountLabel,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";

/**
 * What the person at the keyboard may do to the record on screen.
 *
 * ## Why this exists
 *
 * v1.36.0 shipped account sharing read-only, and everything that consulted
 * the grant lived in the application chrome: the nav bars, the banner, the
 * switcher. No feature surface asked. So a delegate opened `/measurements`
 * inside somebody else's record, saw the add button, filled the form, and was
 * refused by the server. Nothing leaked, because the refusal was right. It
 * still taught them the product was broken. This hook is what every mutation
 * affordance asks before it renders.
 *
 * ## The two answers, and why there are two
 *
 * A grant at WRITE admits a short, closed list of verbs: entering readings,
 * lab results, an illness entry, a biomarker, a side effect, a medication, and
 * marking a dose taken or skipped. It admits nothing else.
 * Allergies and family history were on this list and left it before v1.36.1
 * shipped — the argument for them held, but the only surface that posts to
 * either lives under `/settings`, which a switch closes, so the permission had
 * no reachable caller. Logging a value on a tracked metric left for the same
 * reason one release later: its only form sits on `/custom-metrics/{id}`,
 * which a switch closes too.
 * `delegable-surface-guard.test.ts` carries that argument
 * in full and is the list that binds; this paragraph has to agree with it. Editing, deleting, restoring, purging, importing and
 * bulk-acting stay with the owner, including on an entry the delegate added
 * themselves a minute ago, and so does every create the list does not name
 * (a mood entry, a screener, a cycle day). Two booleans carry that:
 *
 *   - `canAdd` — may this person add one of the admitted kinds.
 *   - `canManage` — may this person change what is already there, or add
 *     something the delegation does not cover. True only in one's own record.
 *
 * A surface that offers an admitted create asks `canAdd`. Everything else
 * asks `canManage`. Neither is a permission decision made here: `canWrite`
 * arrives resolved from the server on `accountAccess.active` and is bound,
 * never recomputed (`account-access-view.ts:11-15`). What this file decides is
 * only which class of affordance a resolved level covers, and that mapping is
 * a property of the release, not of the caller.
 *
 * ## The two facts this hook carries but does not yet act on
 *
 * v1.37.0 gives a grant a section set and a third level, and both arrive here
 * (`sections`, `level`) as resolved values beside the booleans. Nothing in
 * this file turns either into a capability, and that is the state of the
 * release rather than an omission: the nav narrowing that reads `sections`
 * and the return of the edit and delete affordances that reads `level` are
 * the shared-session UX work, which lands after the routes that answer for a
 * MANAGE grant exist. Publishing the facts here first is what lets those be
 * a rendering change rather than a second access decision — and a control
 * that appeared before its route answered would be the failure the two
 * booleans above were written to end.
 *
 * ## Absent, not disabled
 *
 * The consuming rule, stated once here because it belongs to the whole sweep:
 * a control this returns `false` for does not render at all. A greyed-out
 * button still says "this exists and does not work for you"; a control that is
 * simply not there says "this is not part of what you were given", which is
 * the truth. The banner already states the mode globally, so no per-control
 * chip explains the absence — only an empty state a person would otherwise
 * search a button in gets a sentence.
 */
export interface RecordCapabilities {
  /** Is this browser acting on somebody else's record right now. */
  inSharedRecord: boolean;
  /** The grant's resolved level for the record on screen. */
  canWrite: boolean;
  /** May the caller add an entry of a kind the delegation admits. */
  canAdd: boolean;
  /** May the caller change what exists, or add what the delegation excludes. */
  canManage: boolean;
  /**
   * v1.37.0 — the resolved level of the grant on screen, or `null` in one's
   * own record (which is not a grant and has no level).
   *
   * Bound from `accountAccess.active.level`, never derived. `canManage` is
   * deliberately NOT computed from it in this release: the edit and delete
   * affordances come back for `"manage"` when the routes that answer them
   * land, and a control that appears before its route answers is the exact
   * failure the two booleans above exist to prevent.
   */
  level: AccountAccessEntry["level"] | null;
  /**
   * v1.37.0 — the sections the grant opens, or `null` for the entire record
   * (which is also what one's own record answers).
   *
   * Bound from `accountAccess.sections`. An empty array means the grant opens
   * nothing; it is a real answer and reads as one.
   */
  sections: AccountAccessEntry["sections"];
}

/**
 * The mapping, as a pure function of the record the session is inside.
 *
 * Exported so its contract can be pinned without a click: the three states a
 * session can be in are enumerable, and the test enumerates them. `null` is
 * one's own record, which is every capability.
 */
export function resolveRecordCapabilities(
  active: AccountAccessEntry | null | undefined,
): RecordCapabilities {
  if (!active) {
    return {
      inSharedRecord: false,
      canWrite: false,
      canAdd: true,
      canManage: true,
      // One's own record has no grant, so it has no level, and it is open in
      // full. Null on both counts rather than a fabricated "manage" over all
      // eight sections: the caller is not a delegate, and a consumer that had
      // to tell those apart would have to guess.
      level: null,
      sections: null,
    };
  }
  return {
    inSharedRecord: true,
    canWrite: active.canWrite,
    canAdd: active.canWrite,
    canManage: false,
    level: active.level,
    sections: active.sections,
  };
}

/**
 * The record on screen, and what may be done to it.
 *
 * Reads the same resolved block the banner and the switcher read, so the
 * chrome and the controls beneath it cannot disagree about what a delegate
 * was given.
 *
 * Before `/api/auth/me` settles, `active` is absent and the answer is the
 * caller's own record. That is deliberate rather than fail-closed: failing
 * closed would blank every add button in the app for every account on every
 * cold load, to spare a delegate one frame. The switch flow ends in a hard
 * reload, so a delegate's first paint can show an add control for as long as
 * the account query takes, and then it goes. A control that appears and
 * withdraws is a much smaller lie than one that stays and 403s, and the
 * banner lands from the same query in the same frame.
 */
export function useRecordCapabilities(): RecordCapabilities {
  const { user } = useAuth();
  return resolveRecordCapabilities(user?.accountAccess?.active);
}

/**
 * The name of the record this browser is inside, or null in one's own.
 *
 * The delegate's receipt: a mutation that lands under a switch says which
 * record it landed in, because "Saved" alone is the one confirmation a person
 * acting for somebody else does not need. Kept beside the capabilities because
 * it reads the same resolved entry and would otherwise be a fourth place that
 * decides what to call somebody.
 */
export function useActiveRecordName(): string | null {
  const { user } = useAuth();
  const active = user?.accountAccess?.active ?? null;
  return active ? accountLabel(active) : null;
}
