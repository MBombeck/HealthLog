"use client";

import { useAuth } from "@/hooks/use-auth";
import { useRecordSessionTransition } from "@/hooks/use-record-session-transition";
import {
  accountLabel,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";
import type { ShareDomain } from "@/lib/sharing/scope";

const NEVER = () => false;
const ALWAYS = () => true;

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
 * ## The answers, and why there are several
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
 * `sharing-surface-guard.test.ts` carries that argument
 * in full and is the list that binds; this paragraph has to agree with it.
 * Editing, deleting, restoring, purging, importing and bulk-acting are MANAGE
 * verbs, and so is every create the list does not name (a mood entry, a
 * screener, a cycle day). Which sections answer at which level is the
 * server's table (`domain-write-support.ts`), published per grant as two
 * lists on `accountAccess.active`. Four answers carry that:
 *
 *   - `canAdd` — may this person add one of the admitted kinds.
 *   - `canWriteDomain(domain)` — is there a delegated write in this section
 *     the grant satisfies.
 *   - `canManageDomain(domain)` — may this person change what is already
 *     there in this section, or add what a WRITE grant does not cover.
 *   - `canManage` — the coarse switch: is there ANY section this person may
 *     manage. The banner and the navigation ask it; a control never should,
 *     because a control belongs to one section and the answer differs per
 *     section (the vault is read-only under every grant).
 *
 * A surface that offers an admitted create asks `canAdd`. A control that
 * edits, deletes or creates what WRITE does not cover asks `canManageDomain`
 * for its own section. A control whose route resolves the caller rather than
 * the record (settings, credentials, AI budget, chart preferences) asks
 * `!inSharedRecord`: no grant reaches it at any level. None of these is a
 * permission decision made here: `canWrite` and the two lists arrive resolved
 * from the server on `accountAccess.active` and are bound, never recomputed
 * (`account-access-view.ts`). What this file decides is only which class of
 * affordance a resolved answer covers.
 *
 * ## Why the lists are per section
 *
 * v1.37.0 published `level` and `sections` and answered `canManage: false`
 * for every shared record, a hold-back for the release where the level
 * arrived before the routes behind it. The routes landed and the hold-back
 * stayed, so a guardian of a managed profile saw no add, edit or delete
 * control on Mood, screeners, visits, allergies and labs while the server
 * accepted every one of those writes (#939). A single boolean could not have
 * closed that without opening the vault, whose routes accept none; the lists
 * close it section by section, and a section with no delegated route stays
 * closed by the same mechanism.
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
  /** A tab is awaiting a fresh `/me` after another tab changed the session. */
  recordSessionPending?: boolean;
  /** A present account-access block was malformed and must not mount a record. */
  accessRefused?: boolean;
  /** Is this browser acting on somebody else's record right now. */
  inSharedRecord: boolean;
  /** The grant's resolved level for the record on screen. */
  canWrite: boolean;
  /** May the caller add an entry of a kind the delegation admits. */
  canAdd: boolean;
  /**
   * May the caller change what exists somewhere in this record, or add what
   * the delegation excludes. In one's own record, always. In a shared record,
   * true when `manageableDomains` is non-empty: the coarse switch the banner
   * and the navigation read. A control asks {@link canManageDomain} for its
   * own section instead, because the answer differs per section.
   */
  canManage: boolean;
  /**
   * v1.38.12 — is there a delegated write in `domain` this grant satisfies.
   * Own record: always. Shared record: membership in
   * `accountAccess.active.writableDomains`. Refused, pending or unproven
   * context: never.
   */
  canWriteDomain: (domain: ShareDomain) => boolean;
  /**
   * v1.38.12 — may the caller edit, delete or bulk-act in `domain`, or add
   * what a WRITE grant does not cover there. Own record: always. Shared
   * record: membership in `accountAccess.active.manageableDomains`. Refused,
   * pending or unproven context: never.
   */
  canManageDomain: (domain: ShareDomain) => boolean;
  /**
   * v1.37.0 — the resolved level of the grant on screen, or `null` in one's
   * own record (which is not a grant and has no level).
   *
   * Bound from `accountAccess.active.level`, never derived, and not what the
   * controls read: the two domain lists are, because a level says what was
   * granted and the lists say which routes answer for it.
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
  /** The server-resolved kind of the record currently in view. */
  recordKind: AccountAccessEntry["recordKind"] | "self";
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
  accessRefused = false,
  recordSessionPending = false,
  contextUnproven = false,
): RecordCapabilities {
  if (accessRefused || recordSessionPending || contextUnproven) {
    return {
      // An unprovable context is a REFUSAL, not a transient hold, and the
      // difference is whether there is a way out. `recordSessionPending`
      // renders `RecordScopeHydrationGate` — a bare spinner with no controls,
      // correct while a switch is genuinely in flight because it ends on its
      // own. This state does not end on its own: `/api/auth/me` reports the
      // same disagreement on every boot, so a spinner here is a wedge with no
      // exit. `accessRefused` renders `SharedRecordUnavailable`, which carries
      // a "leave this record" button that posts `switch(null)`.
      accessRefused: accessRefused || contextUnproven || undefined,
      recordSessionPending: recordSessionPending || undefined,
      inSharedRecord: true,
      canWrite: false,
      canAdd: false,
      canManage: false,
      canWriteDomain: NEVER,
      canManageDomain: NEVER,
      level: null,
      sections: [],
      recordKind: "shared",
    };
  }
  if (!active) {
    return {
      inSharedRecord: false,
      canWrite: false,
      canAdd: true,
      canManage: true,
      canWriteDomain: ALWAYS,
      canManageDomain: ALWAYS,
      // One's own record has no grant, so it has no level, and it is open in
      // full. Null on both counts rather than a fabricated "manage" over all
      // eight sections: the caller is not a delegate, and a consumer that had
      // to tell those apart would have to guess.
      level: null,
      sections: null,
      recordKind: "self",
    };
  }
  // Bound, not derived: the two lists are the server's intersection of the
  // grant with the routes that exist. Membership is the whole of the client's
  // part, and `canManage` is only the question "is either list non-empty"
  // asked of the manage one.
  const writable = new Set<ShareDomain>(active.writableDomains);
  const manageable = new Set<ShareDomain>(active.manageableDomains);
  return {
    inSharedRecord: true,
    canWrite: active.canWrite,
    canAdd: active.canWrite,
    canManage: manageable.size > 0,
    canWriteDomain: (domain) => writable.has(domain),
    canManageDomain: (domain) => manageable.has(domain),
    level: active.level,
    sections: active.sections,
    recordKind: active.recordKind,
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
/**
 * v1.37.0 — do the two answers about "which record is this" agree.
 *
 * `/api/auth/me` publishes the question twice, from two different angles, and
 * that is deliberate rather than redundant:
 *
 *   * `accountAccess.active` is the RE-DECIDED answer. An entry reaches it only
 *     by surviving a live-grant pass, so a selector left behind by a lapsed
 *     grant reads as "not switched".
 *   * `recordSession.scope` is the RAW selector, the same value the fence
 *     compares a request's assertion against.
 *
 * When they disagree the session is pointed at a record the grant no longer
 * opens: every delegable route will refuse, while `active` being null makes
 * this hook answer "your own record, all controls". That combination paints an
 * add button on a page whose every write is about to 403 — the exact failure
 * `canAdd` was introduced to end. So a disagreement holds instead.
 *
 * A null or absent `recordSession` is not a disagreement. It is the Bearer
 * transport (no session row, no switch state) or a server image that predates
 * the field, and neither is a reason to blank the app.
 */
export function recordContextIsUnproven(
  recordSession: { epoch: number; scope: string | null } | null | undefined,
  active: AccountAccessEntry | null | undefined,
): boolean {
  if (recordSession == null) return false;
  return recordSession.scope !== (active?.accountId ?? null);
}

export function useRecordCapabilities(): RecordCapabilities {
  const { user } = useAuth();
  const transition = useRecordSessionTransition();
  return resolveRecordCapabilities(
    user?.accountAccess?.active,
    user?.accountAccessStatus === "invalid",
    transition.phase !== "ready",
    recordContextIsUnproven(user?.recordSession, user?.accountAccess?.active),
  );
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
