/**
 * The asks: what the start page asks of the person today, at most two
 * things, and nothing at all on most days.
 *
 * One policy, decided here on the server and published as `asks` on the
 * daily digest, so the web and the app show the same two rows (or none) and
 * no client re-ranks them.
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
 *      3. due: a dose that can be taken now, check-ups due today, a visit
 *         that starts within the next 24 hours, a connection that needs a
 *         reconnect.
 *    Inside a tier the digest's own order holds.
 *  - At most {@link MAX_DAILY_ASKS}. What does not fit waits for a later
 *    day or for the ones above it to be answered; it never stacks up.
 *
 * Pure: the inputs are the digest's own candidates, already filtered by the
 * person's item-kind visibility and the dismiss ledger. The IO seam
 * (`load-digest.ts`) reads the snoozes and the admin state.
 */
import { SERVER_SETUP_DOCS } from "@/lib/admin/server-setup";
import type { DailyDigestInput } from "@/lib/daily/digest";
import { ASK_INTENT } from "@/lib/daily/ask-intents";
import { doseWindowItemKey } from "@/lib/daily/priority-item-key";

export { ASK_INTENT };
import type {
  PriorityItem,
  PriorityItemAction,
  PriorityItemKind,
} from "@/lib/daily/priority-item";

/** The most asks the start page shows at once. */
export const MAX_DAILY_ASKS = 2;

/** The tiers, in the order they are asked. */
export const DAILY_ASK_TIERS = ["safety", "decision", "due"] as const;
export type DailyAskTier = (typeof DAILY_ASK_TIERS)[number];

/** The admin questions an ask can carry beside the digest's own kinds. */
export const ADMIN_ASK_KINDS = ["push_relay", "server_setup"] as const;
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

export const DAILY_ASK_KINDS = [
  ...ASKING_ITEM_KINDS,
  ...ADMIN_ASK_KINDS,
] as const;
export type DailyAskKind = (typeof DAILY_ASK_KINDS)[number];

/** Kinds that wait while Rest mode is on (their reminders pause too). */
export const REST_MODE_PAUSED_ASK_KINDS: readonly DailyAskKind[] = [
  "preventive_care",
  "coach_checkin",
];

/** A visit asks from this long before it starts... */
export const VISIT_ASK_AHEAD_MS = 24 * 60 * 60 * 1000;
/** ...until this long after its start (it may be running late). */
export const VISIT_ASK_GRACE_MS = 60 * 60 * 1000;

export interface DailyAsk {
  kind: DailyAskKind;
  tier: DailyAskTier;
  /** Stable identity, namespaced `<kind>:...`. */
  itemKey: string;
  /** Worded on the server, in the response language. */
  title: string;
  /** One sentence, or null. */
  body: string | null;
  /**
   * The name of what is asked about (a medication), for the confirmation an
   * action shows; null when the ask names nothing.
   */
  subject: string | null;
  /** 1 to 3 actions; the first is the primary one. */
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
}

export interface ResolveDailyAsksInput {
  /** The digest's candidates in its own priority order. */
  candidates: readonly AskCandidate[];
  /** The admin question, already worded, when one is open for this admin. */
  adminAsk: DailyAsk | null;
  /** Item keys of doses whose snooze is running. */
  snoozedItemKeys: ReadonlySet<string>;
  restMode: boolean;
  now: Date;
}

function isAskingKind(kind: PriorityItemKind): kind is AskingItemKind {
  return (ASKING_ITEM_KINDS as readonly string[]).includes(kind);
}

/** Whether one of the visits starts inside the ask window around `now`. */
export function visitStartsSoon(
  startsAt: readonly string[],
  now: Date,
): boolean {
  const at = now.getTime();
  return startsAt.some((iso) => {
    const start = Date.parse(iso);
    return (
      Number.isFinite(start) &&
      start >= at - VISIT_ASK_GRACE_MS &&
      start <= at + VISIT_ASK_AHEAD_MS
    );
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
      return visitStartsSoon(candidate.startsAt ?? [], now) ? "due" : null;
    case "sync_issue":
      // A connection that needs a reconnect (`warning`) loses a day of data
      // every day it waits; a source that only went quiet (`info`) is news,
      // told by its notification and its card, and does not ask.
      return item.status === "warning" ? "due" : null;
  }
}

/** The medication id a dose item key names (`dose_window:<id>:<dueAt>`). */
function doseMedicationId(itemKey: string | undefined): string | null {
  if (!itemKey?.startsWith("dose_window:")) return null;
  const id = itemKey.split(":")[1];
  return id && id !== "-" ? id : null;
}

function toAsk(candidate: AskCandidate, tier: DailyAskTier): DailyAsk {
  const { item } = candidate;
  const actions = [...item.actions];
  const medicationId =
    item.kind === "dose_window" ? doseMedicationId(item.itemKey) : null;
  if (medicationId) {
    actions.push({
      labelKey: "daily.action.later",
      intent: `${ASK_INTENT.doseSnooze}:${medicationId}`,
    });
  }
  return {
    kind: item.kind as AskingItemKind,
    tier,
    itemKey: item.itemKey ?? item.kind,
    title: item.title,
    body: item.body ?? null,
    subject: candidate.subject ?? null,
    actions: actions.slice(0, 3),
    learnMore: null,
  };
}

/**
 * The asks of the day: at most {@link MAX_DAILY_ASKS}, by tier, then by the
 * digest's order. An empty list means the start page shows no ask card.
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
  if (input.adminAsk) push(input.adminAsk);
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
    push(toAsk(candidate, tier));
  }

  return ranked
    .sort((a, b) => a.tier - b.tier || a.order - b.order)
    .slice(0, MAX_DAILY_ASKS)
    .map((entry) => entry.ask);
}

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/**
 * The one admin question, worded: the unfinished server setup first, else
 * the open push-relay question. The same two the admin start page asks, with
 * the same answers; "Not now" sets the notice aside as it does there.
 */
export function buildAdminAsk(kind: AdminAskKind, t: Translate): DailyAsk {
  const later: PriorityItemAction = {
    labelKey: "admin.serverSetup.notice.dismiss",
    intent: ASK_INTENT.noticeLater,
  };
  if (kind === "server_setup") {
    return {
      kind,
      tier: "decision",
      itemKey: "server_setup:notice",
      title: t("admin.serverSetup.notice.title"),
      body: t("admin.serverSetup.notice.body"),
      subject: null,
      actions: [
        {
          labelKey: "admin.serverSetup.notice.open",
          intent: ASK_INTENT.setupOpen,
          href: "/onboarding/server",
        },
        later,
      ],
      learnMore: null,
    };
  }
  return {
    kind,
    tier: "decision",
    itemKey: "push_relay:question",
    title: t("admin.pushRelay.question.title"),
    body: t("admin.pushRelay.question.body"),
    subject: null,
    actions: [
      { labelKey: "admin.pushRelay.question.yes", intent: ASK_INTENT.relayYes },
      { labelKey: "admin.pushRelay.question.no", intent: ASK_INTENT.relayNo },
      later,
    ],
    learnMore: {
      labelKey: "admin.pushRelay.docs",
      href: SERVER_SETUP_DOCS.pushRelay,
    },
  };
}

/**
 * The digest's adapter: its candidates (`visible`, already filtered by item
 * kind and the dismiss ledger, before the rail's cap) with what the policy
 * reads about each, looked up by item key from the digest's own input: a
 * dose's resolver state and name, the start of the visits an item names.
 */
export function asksFromDigest(
  input: DailyDigestInput,
  visible: readonly PriorityItem[],
  t: Translate,
): DailyAsk[] {
  const meds = input.medsToday;
  const doses = new Map<string, { overdue: boolean; name: string | null }>();
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
    });
  }
  const visits = input.upcomingVisits ?? [];
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
  return resolveDailyAsks({
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
      };
    }),
    adminAsk: input.adminAsk ? buildAdminAsk(input.adminAsk, t) : null,
    snoozedItemKeys: input.snoozedDoseItemKeys ?? new Set(),
    restMode: Boolean(input.restMode),
    now: input.now,
  });
}
