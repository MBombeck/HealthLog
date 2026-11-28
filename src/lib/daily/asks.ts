/**
 * The asks: what the start page asks of the person today, and nothing at
 * all on most days.
 *
 * One policy, decided here on the server and published as `asks` on the
 * daily digest, so the web and the app show the same rows (or none) and no
 * client re-ranks them.
 *
 *  - Only something that needs an action today and is time-relevant. The
 *    observational kinds (a milestone, a new ECG, a tension window, a
 *    same-time read) never ask; they are not a question.
 *  - A "no" or a "later" holds: a snoozed dose is not asked again while its
 *    snooze runs, a dismissed admin notice is gone, an answered question is
 *    gone. Rest mode pauses the check-up and the coach check-in, as the
 *    reminders themselves pause.
 *  - A fixed order of tiers, first the one that cannot wait:
 *      1. safety: a dose past its on-time window;
 *      2. decision: a question only the person can answer (the push relay
 *         or the server setup for an admin, a coach check-in);
 *      3. due: a dose that can be taken now, check-ups due now, a visit
 *         today or tomorrow, a source whose sign-in expired or was refused
 *         and that has delivered nothing for a day, a source the stall rule
 *         holds quiet (`source_stalled`, one per source, never beside a
 *         sign-in ask for the same source).
 *    Inside a tier the digest's own order holds.
 *  - No cap and no fold: every row that passes these rules is asked, in
 *    that order. The rules are what keeps the card short; more than
 *    {@link ASKS_EXPECTED_MAX} rows logs a warning outside production,
 *    because it means the rules let too much through.
 *  - Every row has exactly two actions: the action itself (primary) and
 *    "Later" for a reminder (the medication's own snooze for a dose, the
 *    notice's "not now" for the server setup, and for everything else the
 *    ask set aside until the next local day through the dismiss ledger), or
 *    No and Yes for a consent.
 *  - A consent question ({@link CONSENT_ASK_KINDS}) offers its real answers,
 *    No and Yes, and no "later": a no is recorded in one tap and holds; an
 *    unanswered question simply stays until it is answered.
 *  - Each action carries the short label of its verb (`daily.action.*`), so
 *    every button of the card fits one size in every language.
 *  - The wording is object and state: the title names the thing (the
 *    medication, the check-up, the visit, the source, the plan), the body
 *    its state in a few words (`daily.ask.*`, `wordAsk`). One line each on a
 *    phone in every language; a name the person typed may still run long,
 *    and the card cuts only that.
 *
 * Pure: the inputs are the digest's own candidates, already filtered by the
 * person's item-kind visibility and the dismiss ledger. The IO seam
 * (`load-digest.ts`) reads the snoozes and the admin state.
 */
import {
  CONNECTION_LABELS,
  type ConnectionKey,
} from "@/lib/integrations/connection-health";
import type { DailyDigestInput } from "@/lib/daily/digest";
import type { DailyDigestQuietSource } from "@/lib/daily/quiet-source-items";
import type { Locale } from "@/lib/i18n/config";
import { pluralKey } from "@/lib/i18n/plural";
import {
  ASK_INTENT,
  askLaterKey,
  OPTIONAL_ASK_KINDS,
} from "@/lib/daily/ask-intents";
import {
  coachCheckinItemKey,
  doseWindowItemKey,
  syncIssueItemKey,
} from "@/lib/daily/priority-item-key";
import { COACH_CHECKIN_ADJUST_INTENT } from "@/lib/daily/coach-checkin-intents";
import type { EncounterKind } from "@/generated/prisma/client";
import { resolveIntlLocale } from "@/lib/format-locale";
import { getDateTimeFormat } from "@/lib/intl/formatter-cache";
import { encounterKindLabelKey } from "@/lib/encounters/kind-label";

export { ASK_INTENT, OPTIONAL_ASK_KINDS };
import type {
  PriorityItem,
  PriorityItemAction,
  PriorityItemKind,
} from "@/lib/daily/priority-item";

/**
 * The one text budget of an ask, shared with the iPhone app: in every
 * language, a title the server words itself is at most `titleChars`
 * characters and a meta line (`body`) at most `metaChars`, so both fit one
 * line beside the icon and the button pair on the narrowest phone either
 * client supports (`phoneCssPx`, 360 css px / 375 pt), even with a 15 px
 * scrollbar taking width. A title over budget (a name the person typed)
 * ends in an ellipsis on the client; a meta never does, so the server never
 * sends one over budget. The numbers come from measuring every language's
 * longest line in Inter on the web card. Guard: `asks-text-budget.test.ts`.
 */
export const ASK_TEXT_BUDGET = {
  titleChars: 14,
  metaChars: 16,
  phoneCssPx: 360,
  /**
   * Widest button label, Inter 12 px medium: the compact face is 76 px with
   * its 6 px padding, so no label widens the card's shared button column.
   */
  labelPx: 64,
} as const;

/** Characters as a reader counts them (code points, not UTF-16 units). */
export function askTextLength(text: string): number {
  return [...text].length;
}

/** More rows than this means the rules let too much through. */
export const ASKS_EXPECTED_MAX = 5;

/** Whether an ask shows even when its category is switched off. */
export function isMandatoryAsk(ask: Pick<DailyAsk, "kind" | "tier">): boolean {
  return (
    ask.tier === "safety" ||
    (ADMIN_ASK_KINDS as readonly string[]).includes(ask.kind)
  );
}

/** Asks that are a consent: answered Yes or No, never deferred. */
export const CONSENT_ASK_KINDS: readonly DailyAskKind[] = ["push_relay"];

/**
 * The rail intent an ask takes as its primary action, per kind, and the
 * short verb it shows. A coach check-in is answered in the Coach (its
 * "adjust" link carries the plan as the question).
 */
const PRIMARY_BY_KIND: Record<
  AskingItemKind | SourceAskKind,
  { intent: string; labelKey: string }
> = {
  dose_window: { intent: "dose.log", labelKey: "daily.action.logDose" },
  preventive_care: { intent: "checkup.view", labelKey: "daily.action.open" },
  upcoming_visit: { intent: "checkup.view", labelKey: "daily.action.open" },
  sync_issue: {
    intent: "sync.reconnect",
    labelKey: "daily.action.reconnectShort",
  },
  // `sync.reconnect` with the source's own card as `href`, as the rail's
  // quiet line: every shipped iOS build routes it to the integrations
  // screen, where a new token would be a dead button.
  source_stalled: { intent: "sync.reconnect", labelKey: "daily.action.open" },
  coach_checkin: {
    intent: COACH_CHECKIN_ADJUST_INTENT,
    labelKey: "daily.action.answer",
  },
};

/** The tiers, in the order they are asked. */
export const DAILY_ASK_TIERS = ["safety", "decision", "due"] as const;
export type DailyAskTier = (typeof DAILY_ASK_TIERS)[number];

/** The admin questions an ask can carry beside the digest's own kinds. */
export const ADMIN_ASK_KINDS = ["push_relay", "server_setup"] as const;

/** The server setup ask's item key, and the key its "later" sets aside. */
const SERVER_SETUP_ASK_KEY = "server_setup:notice";
export type AdminAskKind = (typeof ADMIN_ASK_KINDS)[number];

/** The digest kinds that can ask. Everything else is information. */
export const ASKING_ITEM_KINDS = [
  "dose_window",
  "coach_checkin",
  "preventive_care",
  "upcoming_visit",
  "sync_issue",
] as const satisfies readonly PriorityItemKind[];
export type AskingItemKind = (typeof ASKING_ITEM_KINDS)[number];

/**
 * The kinds the asks word from the stall rule's answer (the digest's
 * `quietSources`, `src/lib/sync-stall/quiet.ts`), not from a rail item.
 */
export const SOURCE_ASK_KINDS = ["source_stalled"] as const;
export type SourceAskKind = (typeof SOURCE_ASK_KINDS)[number];

export const DAILY_ASK_KINDS = [
  ...ASKING_ITEM_KINDS,
  ...SOURCE_ASK_KINDS,
  ...ADMIN_ASK_KINDS,
] as const;
export type DailyAskKind = (typeof DAILY_ASK_KINDS)[number];

/** Kinds that wait while Rest mode is on (their reminders pause too). */
export const REST_MODE_PAUSED_ASK_KINDS: readonly DailyAskKind[] = [
  "preventive_care",
  "coach_checkin",
];

/** A visit of today asks until this long after its start (running late). */
export const VISIT_ASK_GRACE_MS = 60 * 60 * 1000;

/** A broken source asks once nothing has arrived for this long. */
export const SYNC_ASK_AFTER_MS = 24 * 60 * 60 * 1000;

/** The integration states only the person can mend. */
export const SYNC_ASK_STATES: readonly string[] = ["error_reauth"];

/**
 * The switch a source ask follows on Settings › Dashboard: the sync
 * category, the same one a reconnect ask follows.
 */
export const SOURCE_ASK_CATEGORY = "sync_issue" as const;

/**
 * A source ask's title where the provider's name would not fit the row
 * (`ASK_TEXT_BUDGET`): the phone that went quiet, by its platform.
 */
export const SOURCE_ASK_TITLE: Readonly<Partial<Record<string, string>>> = {
  "health-connect-app": "Android",
};

/** `source_stalled:<source>`: one ask per source. */
export function sourceStalledAskKey(source: string): string {
  return `source_stalled:${source}`;
}

export interface DailyAsk {
  kind: DailyAskKind;
  tier: DailyAskTier;
  /** Stable identity, namespaced `<kind>:...`. */
  itemKey: string;
  /**
   * The thing asked about, one line: a medication's name, a check-up, who a
   * visit is with, a source, the coach plan. Worded on the server, in the
   * response language.
   */
  title: string;
  /**
   * Its state, one short line ("Overdue 8:00 AM", "Visit tomorrow"),
   * worded to fit one line on a phone in every language
   * (`asks-text-budget.test.ts`). Null only for an ask built outside the
   * digest (a test fixture).
   */
  body: string | null;
  /**
   * The name of what is asked about (a medication), for the confirmation an
   * action shows; null when the ask names nothing.
   */
  subject: string | null;
  /** Exactly two actions; the first is the primary one. */
  actions: PriorityItemAction[];
  /** A link at the end of the sentence, label as an i18n key. */
  learnMore: { labelKey: string; href: string } | null;
}

/** One digest candidate and what the policy needs to know about it. */
export interface AskCandidate {
  item: PriorityItem;
  /** A dose past its on-time window (the dose resolver's `overdue`). */
  overdue?: boolean;
  /** What the item is about by name (a dose's medication). */
  subject?: string | null;
  /** For a visit item: the ISO start of each visit it names. */
  startsAt?: readonly string[];
  /** For a visit item: its local day, 0 today, 1 tomorrow. */
  dayOffset?: number;
  /**
   * For a sync item: the source is broken and only the person can mend it
   * (sign-in expired or refused) and nothing has arrived for a day.
   */
  needsPerson?: boolean;
}

export interface ResolveDailyAsksInput {
  /** The digest's candidates in its own priority order. */
  candidates: readonly AskCandidate[];
  /**
   * The kinds the person keeps on the start page (the layout's
   * `enabledHeroItemKinds`); missing means all. A mandatory ask
   * ({@link isMandatoryAsk}) shows whatever this says.
   */
  enabledKinds?: readonly string[];
  /** The admin question, already worded, when one is open for this admin. */
  adminAsk: DailyAsk | null;
  /**
   * The quiet-source asks, already worded and already narrowed to the
   * eligible ones (`sourceStalledAsks`); the policy holds them to the
   * snoozes and the sync switch like any other row.
   */
  sourceAsks?: readonly DailyAsk[];
  /** Item keys held back: a dose's running snooze, an ask set aside today. */
  snoozedItemKeys: ReadonlySet<string>;
  /** The reader's local day, `YYYY-MM-DD`, for the "later" key. */
  today: string;
  restMode: boolean;
  now: Date;
}

function isAskingKind(kind: PriorityItemKind): kind is AskingItemKind {
  return (ASKING_ITEM_KINDS as readonly string[]).includes(kind);
}

/** Whether one of today's visits has not long started, or is still ahead. */
export function visitStartsSoon(
  startsAt: readonly string[],
  now: Date,
): boolean {
  const at = now.getTime();
  return startsAt.some((iso) => {
    const start = Date.parse(iso);
    return Number.isFinite(start) && start >= at - VISIT_ASK_GRACE_MS;
  });
}

/** The tier of one candidate, or null when it does not ask today. */
export function askTier(
  candidate: AskCandidate,
  now: Date,
): DailyAskTier | null {
  const { item } = candidate;
  if (!isAskingKind(item.kind)) return null;
  switch (item.kind) {
    case "dose_window":
      return candidate.overdue ? "safety" : "due";
    case "coach_checkin":
      return "decision";
    case "preventive_care":
      return "due";
    case "upcoming_visit":
      // Today (not long past its start) or tomorrow, never further out. A
      // "later" keys on the day offset, so a visit set aside the day before
      // comes back on the day itself, once.
      if (candidate.dayOffset === 1) return "due";
      if (candidate.dayOffset === 0) {
        return visitStartsSoon(candidate.startsAt ?? [], now) ? "due" : null;
      }
      return null;
    case "sync_issue":
      // Only a source that is broken and needs the person (a sign-in that
      // expired or was refused) and has delivered nothing for a day. A
      // source quiet for a few hours, or a sync the server retries on its
      // own, is told by its notification and its card.
      return item.status === "warning" && candidate.needsPerson === true
        ? "due"
        : null;
  }
}

/** The medication id a dose item key names (`dose_window:<id>:<dueAt>`). */
function doseMedicationId(itemKey: string | undefined): string | null {
  if (!itemKey?.startsWith("dose_window:")) return null;
  const id = itemKey.split(":")[1];
  return id && id !== "-" ? id : null;
}

function toAsk(
  candidate: AskCandidate,
  tier: DailyAskTier,
  today: string,
): DailyAsk | null {
  const { item } = candidate;
  const kind = item.kind as AskingItemKind;
  const itemKey = item.itemKey ?? item.kind;
  const spec = PRIMARY_BY_KIND[kind];
  const source = item.actions.find(
    (a) => a.intent.split(":")[0] === spec.intent,
  );
  // No action to take means nothing to ask.
  if (!source) return null;
  const primary = { ...source, labelKey: spec.labelKey };
  const medicationId =
    kind === "dose_window" ? doseMedicationId(item.itemKey) : null;
  const later = medicationId
    ? {
        labelKey: "daily.action.later",
        intent: `${ASK_INTENT.doseSnooze}:${medicationId}`,
      }
    : {
        labelKey: "daily.action.later",
        intent: `${ASK_INTENT.later}:${askLaterKey(today, itemKey)}`,
      };
  return {
    kind,
    tier,
    itemKey,
    title: item.title,
    body: item.body ?? null,
    subject: candidate.subject ?? null,
    actions: [primary, later],
    learnMore: null,
  };
}

/**
 * The asks of the day, by tier, then by the digest's order. An empty list
 * means the start page shows no ask card.
 */
export function resolveDailyAsks(input: ResolveDailyAsksInput): DailyAsk[] {
  const ranked: Array<{ ask: DailyAsk; tier: number; order: number }> = [];
  let order = 0;
  const push = (ask: DailyAsk) =>
    ranked.push({
      ask,
      tier: DAILY_ASK_TIERS.indexOf(ask.tier),
      order: order++,
    });

  // The admin question first: inside the decision tier it is the one that
  // holds up the server for everyone (reminders on the iPhone, Wallet).
  if (input.adminAsk && !input.snoozedItemKeys.has(input.adminAsk.itemKey)) {
    push(input.adminAsk);
  }
  for (const candidate of input.candidates) {
    const tier = askTier(candidate, input.now);
    if (tier === null) continue;
    const kind = candidate.item.kind;
    if (
      input.restMode &&
      (REST_MODE_PAUSED_ASK_KINDS as readonly string[]).includes(kind)
    )
      continue;
    const key = candidate.item.itemKey;
    if (key && input.snoozedItemKeys.has(key)) continue;
    const ask = toAsk(candidate, tier, input.today);
    if (!ask) continue;
    if (
      input.enabledKinds &&
      !input.enabledKinds.includes(kind) &&
      !isMandatoryAsk(ask)
    ) {
      continue;
    }
    push(ask);
  }
  // Behind the rail's own candidates: the reconnects of the due tier come
  // first, then what only went quiet.
  for (const ask of input.sourceAsks ?? []) {
    if (input.snoozedItemKeys.has(ask.itemKey)) continue;
    if (
      input.enabledKinds &&
      !input.enabledKinds.includes(SOURCE_ASK_CATEGORY)
    ) {
      continue;
    }
    push(ask);
  }

  const asks = ranked
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .map((entry) => entry.ask);
  if (
    process.env.NODE_ENV !== "production" &&
    asks.length > ASKS_EXPECTED_MAX
  ) {
    console.warn(
      `[asks] ${asks.length} asks at once (more than ${ASKS_EXPECTED_MAX}): the policy may be too loose.`,
    );
  }
  return asks;
}

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * The one admin question, worded: the unfinished server setup first, else
 * the open push-relay question. The setup is a reminder: Set up, or Later,
 * which sets it aside for the rest of the local day like every other ask
 * (`ask.later`), so it comes back tomorrow and the relay question behind it
 * is never lost. The relay is a consent: No and Yes, the answers the admin
 * start page records.
 */
export function buildAdminAsk(
  kind: AdminAskKind,
  t: Translate,
  today: string,
): DailyAsk {
  if (kind === "server_setup") {
    return {
      kind,
      tier: "decision",
      itemKey: SERVER_SETUP_ASK_KEY,
      title: t("daily.ask.setupTitle"),
      body: t("daily.ask.setupMeta"),
      subject: null,
      actions: [
        {
          labelKey: "daily.action.setUp",
          intent: ASK_INTENT.setupOpen,
          href: "/onboarding/server",
        },
        {
          labelKey: "daily.action.later",
          intent: `${ASK_INTENT.later}:${askLaterKey(today, SERVER_SETUP_ASK_KEY)}`,
        },
      ],
      learnMore: null,
    };
  }
  return {
    kind,
    tier: "decision",
    itemKey: "push_relay:question",
    title: t("daily.ask.relayTitle"),
    body: t("daily.ask.relayMeta"),
    subject: null,
    actions: [
      { labelKey: "admin.pushRelay.question.yes", intent: ASK_INTENT.relayYes },
      { labelKey: "admin.pushRelay.question.no", intent: ASK_INTENT.relayNo },
    ],
    // No link on the row: it has no room on a phone, and "Yes" opens the
    // relay dialog, which links the terms and the privacy notice before
    // anything is switched on.
    learnMore: null,
  };
}

/** The most days a quiet source's line counts; past it, the state alone. */
const QUIET_COUNT_MAX = 99;

/**
 * A quiet source's state line: the local days since its last delivery
 * ("3 days quiet"), or the state alone ("No data") past
 * {@link QUIET_COUNT_MAX} or when the count would take the line past the
 * budget.
 */
export function quietMeta(days: number, locale: Locale, t: Translate): string {
  const count = Math.max(1, Math.floor(days));
  if (count > QUIET_COUNT_MAX) return t("daily.ask.quiet");
  const withCount = t(pluralKey("daily.ask.quietDays", count, locale), {
    count,
  });
  return askTextLength(withCount) <= ASK_TEXT_BUDGET.metaChars
    ? withCount
    : t("daily.ask.quiet");
}

/**
 * One ask per source the stall rule holds quiet now (`quietSources`, read by
 * the digest through `loadQuietSources`; no second idea of "quiet" here).
 * Not for a source whose sign-in needs renewing: the reconnect ask names it.
 * A source whose only module is off never reaches here: the stall rule
 * leaves it out. Titled with the provider's name, or its short name where
 * the name would not fit the row; its state the days it has been quiet;
 * "Open" leads to the source's own card, "Later" sets it aside for the day.
 */
export function sourceStalledAsks(
  input: {
    quietSources?: readonly DailyDigestQuietSource[];
    syncIssues: DailyDigestInput["syncIssues"];
    todayLocalDate: string;
    locale?: Locale;
  },
  t: Translate,
): DailyAsk[] {
  const covered = new Set(
    input.syncIssues
      .filter((issue) => SYNC_ASK_STATES.includes(issue.state))
      .map((issue) => issue.integration),
  );
  const seen = new Set<string>();
  const asks: DailyAsk[] = [];
  for (const quiet of input.quietSources ?? []) {
    if (covered.has(quiet.source) || seen.has(quiet.source)) continue;
    seen.add(quiet.source);
    const itemKey = sourceStalledAskKey(quiet.source);
    const spec = PRIMARY_BY_KIND.source_stalled;
    asks.push({
      kind: "source_stalled",
      tier: "due",
      itemKey,
      title: SOURCE_ASK_TITLE[quiet.source] ?? quiet.provider,
      body: quietMeta(quiet.days, input.locale ?? "en", t),
      subject: null,
      actions: [
        { labelKey: spec.labelKey, intent: spec.intent, href: quiet.href },
        {
          labelKey: "daily.action.later",
          intent: `${ASK_INTENT.later}:${askLaterKey(input.todayLocalDate, itemKey)}`,
        },
      ],
      learnMore: null,
    });
  }
  return asks;
}

/**
 * The digest's adapter: every item the digest built (before the rail's
 * kind filter and cap: the asks apply the person's switches themselves, so
 * a mandatory ask survives them) with what the policy reads about each,
 * looked up by item key from the digest's own input: a dose's resolver
 * state and name, the start of the visits an item names. The dismiss ledger
 * only holds observational kinds, which never ask.
 */
export function asksFromDigest(
  input: DailyDigestInput,
  visible: readonly PriorityItem[],
  t: Translate,
): DailyAsk[] {
  const meds = input.medsToday;
  const doses = new Map<
    string,
    { overdue: boolean; name: string | null; dueAt: string }
  >();
  const dueCandidates =
    meds.dueCandidates ??
    (meds.nextDueAt || meds.nextDueOverdue
      ? [
          {
            medicationId: meds.nextDueMedicationId ?? "",
            medicationName: meds.nextDueMedicationName ?? "",
            dueAt: meds.nextDueAt ?? "",
            overdue: meds.nextDueOverdue,
          },
        ]
      : []);
  for (const c of dueCandidates) {
    doses.set(doseWindowItemKey(c.medicationId, c.dueAt), {
      overdue: c.overdue,
      name: c.medicationName || null,
      dueAt: c.dueAt,
    });
  }
  const visits = input.upcomingVisits ?? [];
  const syncNeedsPerson = (itemKey: string | undefined): boolean => {
    const issue = input.syncIssues.find(
      (i) => itemKey === `sync_issue:${i.integration}`,
    );
    if (!issue || !SYNC_ASK_STATES.includes(issue.state)) return false;
    const last = issue.lastSuccessAt ? Date.parse(issue.lastSuccessAt) : NaN;
    return (
      !Number.isFinite(last) || input.now.getTime() - last > SYNC_ASK_AFTER_MS
    );
  };
  const visitDay = (itemKey: string | undefined): number | undefined => {
    const first = visits.find((v) => itemKey?.endsWith(`:${v.id}`));
    return first ? Math.max(0, first.dayOffset) : undefined;
  };
  const visitStarts = (itemKey: string | undefined): string[] => {
    const first = visits.find((v) => itemKey?.endsWith(`:${v.id}`));
    if (!first) return [];
    const today = first.dayOffset <= 0;
    return visits
      .filter((v) =>
        today ? v.dayOffset <= 0 : v.dayOffset === first.dayOffset,
      )
      .map((v) => v.occurredAt);
  };
  const asks = resolveDailyAsks({
    candidates: visible.map((item) => {
      const dose = item.itemKey ? doses.get(item.itemKey) : undefined;
      return {
        item,
        overdue: dose?.overdue ?? false,
        subject: dose?.name ?? null,
        startsAt:
          item.kind === "upcoming_visit"
            ? visitStarts(item.itemKey)
            : undefined,
        dayOffset:
          item.kind === "upcoming_visit" ? visitDay(item.itemKey) : undefined,
        needsPerson:
          item.kind === "sync_issue"
            ? syncNeedsPerson(item.itemKey)
            : undefined,
      };
    }),
    adminAsk: input.adminAsk
      ? buildAdminAsk(input.adminAsk, t, input.todayLocalDate)
      : null,
    sourceAsks: sourceStalledAsks(input, t),
    enabledKinds: input.enabledHeroItemKinds,
    snoozedItemKeys: input.snoozedDoseItemKeys ?? new Set(),
    today: input.todayLocalDate,
    restMode: Boolean(input.restMode),
    now: input.now,
  });
  return asks.map((ask) => ({
    ...ask,
    ...wordAsk(ask, { input, doses, visits }, t),
  }));
}

/** What `wordAsk` reads beside the ask: the digest's own input. */
interface WordingContext {
  input: Pick<
    DailyDigestInput,
    "preventiveDue" | "coachPlans" | "syncIssues" | "localTime" | "locale"
  >;
  doses: ReadonlyMap<
    string,
    { overdue: boolean; name: string | null; dueAt: string }
  >;
  visits: readonly NonNullable<DailyDigestInput["upcomingVisits"]>[number][];
}

/**
 * A dose's meta: the state with the time it was due, or the state alone
 * when there is no time or the time would take the line past the budget (a
 * 12-hour clock a reader forced on a language that counts 24).
 */
export function doseMeta(
  overdue: boolean,
  time: string | null,
  t: Translate,
  /** The same instant on the language's own clock, when known. */
  ownTime?: string | null,
): string {
  // A label longer than the language's own clock is an hour cycle the
  // reader forced ("8:00 AM" in German, Russian): its suffix is what runs a
  // line past the column, so the state goes alone.
  const forced = Boolean(time && ownTime && time.length > ownTime.length);
  const withTime =
    time && !forced
      ? t(overdue ? "daily.ask.overdue" : "daily.ask.due", { time })
      : null;
  return withTime && askTextLength(withTime) <= ASK_TEXT_BUDGET.metaChars
    ? withTime
    : t(overdue ? "daily.ask.overdueNow" : "daily.ask.dueNow");
}

/** An instant on the language's own clock (its default hour cycle). */
function ownClock(
  iso: string | undefined,
  locale: Locale | undefined,
): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!locale || !Number.isFinite(at)) return null;
  // The language's default hour cycle: no preference applied, and no date.
  return getDateTimeFormat(resolveIntlLocale(locale), {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

/** How many due check-ups a title names before it counts the rest. */
const CHECKUP_TITLE_NAMED = 1;

/**
 * An ask's two lines, object and state. The rail item's own title and body
 * stay as they are (they are sentences, for the notification and the rail);
 * an ask says the thing in its title and its state in a few words, so both
 * fit one line on a phone. The admin asks are worded where they are built.
 */
export function wordAsk(
  ask: DailyAsk,
  { input, doses, visits }: WordingContext,
  t: Translate,
): Pick<DailyAsk, "title" | "body"> {
  const time = (iso: string | undefined): string | null => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) && input.localTime
      ? input.localTime(new Date(at))
      : null;
  };
  switch (ask.kind) {
    case "dose_window": {
      const dose = doses.get(ask.itemKey);
      const at = time(dose?.dueAt);
      const overdue = ask.tier === "safety";
      return {
        title: dose?.name ?? ask.subject ?? t("daily.ask.medication"),
        body: doseMeta(overdue, at, t, ownClock(dose?.dueAt, input.locale)),
      };
    }
    case "preventive_care": {
      const labels = input.preventiveDue.map((d) => d.label);
      const rest = labels.length - CHECKUP_TITLE_NAMED;
      return {
        title:
          labels.length === 0
            ? ask.title
            : rest > 0
              ? `${labels[0]} +${rest}`
              : labels[0],
        body: t("daily.ask.checkupDue"),
      };
    }
    case "upcoming_visit": {
      const first = visits.find((v) => ask.itemKey.endsWith(`:${v.id}`));
      const offset = first ? Math.max(0, first.dayOffset) : 0;
      const names = visits
        .filter((v) => Math.max(0, v.dayOffset) === offset)
        .map(
          (v) =>
            v.practitionerName ??
            t(encounterKindLabelKey(v.kind as EncounterKind)),
        );
      return {
        title:
          names.length > 0 ? Array.from(new Set(names)).join(", ") : ask.title,
        body: t(
          offset === 0 ? "daily.ask.visitToday" : "daily.ask.visitTomorrow",
        ),
      };
    }
    case "sync_issue": {
      const issue = input.syncIssues.find(
        (i) => syncIssueItemKey(i.integration) === ask.itemKey,
      );
      const token = issue?.integration ?? "";
      return {
        title:
          CONNECTION_LABELS[token as ConnectionKey] ??
          (token ? token.charAt(0).toUpperCase() + token.slice(1) : ask.title),
        body: t("daily.ask.signedOut"),
      };
    }
    case "coach_checkin": {
      const plan = input.coachPlans.find(
        (p) => coachCheckinItemKey(p.id) === ask.itemKey,
      );
      // The thing is what the plan does, not its "cue → action" prose: the
      // action alone, with no arrow in visible copy, as a title.
      const action = plan?.planText?.split("→").pop()?.trim();
      return {
        title: action
          ? action.charAt(0).toLocaleUpperCase() + action.slice(1)
          : t("daily.ask.planFallback"),
        body: t("daily.ask.planReview"),
      };
    }
    case "source_stalled":
    case "push_relay":
    case "server_setup":
      return { title: ask.title, body: ask.body };
  }
}
