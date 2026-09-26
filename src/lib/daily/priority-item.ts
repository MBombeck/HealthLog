/**
 * P1 — `PriorityItem`, the ONE typed model behind every "worth a look" item.
 *
 * A `PriorityItem` is the single rendering unit for every rail entry the
 * unified daily-value system produces: a coach check-in, a dose-window CTA, a
 * Vorsorge nudge, a failed-sync retry, a durable milestone, a new-ECG pointer,
 * and an elevated-at-rest tension window. Later slices (Today rail S2, coach
 * check-in S3, ECG weave S10, milestones S12, tension S11) each add ONE `kind`
 * plus a server-side item builder — never a new component. `PriorityCard`
 * renders it; `buildDailyDigest` emits it.
 *
 * The type is deliberately WIRE-SERIALISABLE: the digest DTO crosses the
 * `GET /api/daily/digest` boundary (and, later, a native-client / iOS-widget
 * boundary), so an item carries no React component. The card derives its
 * Lucide glyph deterministically from `kind` (see `KIND_ICON` in
 * `src/components/daily/priority-card.tsx`) — the icon lives with the
 * renderer, the closed `kind` enum with the model. This is the one intentional
 * departure from the Fable §1.2 code block (which sketched `icon: LucideIcon`
 * inline); a serialisable single-source-of-truth DTO cannot hold a component.
 */
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * Closed set of rail-item kinds. A new kind also needs its server builder and
 * dashboard-layout label. Typed consumers derive from this tuple so stored
 * visibility settings and API validation cannot accept vocabulary the current
 * build does not understand.
 *
 * A new kind also needs a data migration that appends it to every stored,
 * non-empty `enabledHeroItemKinds` list. The layout stores the ENABLED kinds
 * whenever they are not all of them, so a list saved before the kind existed
 * reads as "switched off" and the new kind never shows for that person.
 * `upcoming_visit` shipped without one and stayed hidden that way until
 * migration 0355 appended it.
 */
export const PRIORITY_ITEM_KINDS = [
  "coach_checkin",
  "dose_window",
  "preventive_care",
  "sync_issue",
  "milestone",
  "ecg_new_recording",
  "tension_window",
  "same_time_baseline",
  "upcoming_visit",
] as const;

export type PriorityItemKind = (typeof PRIORITY_ITEM_KINDS)[number];

export function isPriorityItemKind(value: unknown): value is PriorityItemKind {
  return (
    typeof value === "string" &&
    (PRIORITY_ITEM_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The OBSERVATIONAL kinds — a durable-state reward, a new-ECG pointer, an
 * elevated-at-rest window, a same-time activity read. These carry no pending
 * action; the user can only
 * acknowledge them, so they're the only kinds the Today rail lets you
 * dismiss. The remaining kinds (`dose_window`, `sync_issue`,
 * `preventive_care`, `coach_checkin`, `upcoming_visit`) are ACTIONABLE — they clear on their
 * own once the user acts (logs the dose, reconnects the integration, …) and
 * are never dismissible; offering a dismiss on them would just let a user
 * silence a still-open action item.
 */
export const DISMISSIBLE_PRIORITY_ITEM_KINDS = [
  "milestone",
  "ecg_new_recording",
  "tension_window",
  "same_time_baseline",
] as const satisfies readonly PriorityItemKind[];

export type DismissiblePriorityItemKind =
  (typeof DISMISSIBLE_PRIORITY_ITEM_KINDS)[number];

/** Whether `kind` is one of the dismissible observational kinds. */
export function isDismissibleKind(
  kind: PriorityItemKind,
): kind is DismissiblePriorityItemKind {
  return (DISMISSIBLE_PRIORITY_ITEM_KINDS as readonly string[]).includes(kind);
}

/**
 * The dismiss ledger's natural key is namespaced by kind (`<kind>:...`), so
 * the prefix alone tells the server the key names a dismissible instance —
 * no separate `kind` field needs to cross the wire. Shared by the digest
 * builder (which stamps the key) and the dismiss route's Zod schema (which
 * rejects anything else structurally, before a lookup ever runs).
 */
const DISMISSIBLE_NOTICE_PREFIXES = [
  "health_score_algorithm",
  "health-score",
] as const;

/**
 * The notice prefixes whose dismissal changes what the score report says,
 * and therefore has to evict the cached report.
 *
 * Both entries are score notices — the method/recipe note and the
 * composition note. Named rather than repeated as a literal at the dismiss
 * route, because the route matched exactly one of them for a release and a
 * second one added there by hand is a dismissal that appears to work and
 * comes back on the next read.
 */
export const SCORE_NOTICE_ITEM_KEY_PREFIXES = [
  "health_score_algorithm",
  "health-score",
] as const;

/** Whether dismissing `itemKey` invalidates the cached Health Score report. */
export function isScoreNoticeItemKey(itemKey: string): boolean {
  return SCORE_NOTICE_ITEM_KEY_PREFIXES.some((prefix) =>
    itemKey.startsWith(`${prefix}:`),
  );
}

export function isDismissibleItemKey(itemKey: string): boolean {
  return (
    DISMISSIBLE_PRIORITY_ITEM_KINDS.some((kind) =>
      itemKey.startsWith(`${kind}:`),
    ) ||
    DISMISSIBLE_NOTICE_PREFIXES.some((prefix) =>
      itemKey.startsWith(`${prefix}:`),
    )
  );
}

/**
 * Semantic status — meaning, not decoration. Maps to a `text-<status>` plus a
 * `bg-<status>/10` wash in the card (§3 status-colour tier), never raw palette.
 */
export type PriorityItemStatus = "success" | "warning" | "info" | "destructive";

/**
 * One of the 1–3 one-tap actions a card offers. `labelKey` is an i18n key
 * resolved CLIENT-side (the card owns the user's locale); `intent` is a stable
 * token the consumer switches on to wire the tap; `href` deep-links when the
 * action is pure navigation.
 */
export interface PriorityItemAction {
  /** i18n key under `daily.action.*`, resolved by `PriorityCard`. */
  labelKey: string;
  /** Stable action token (`dose.log`, `sync.reconnect`, …). */
  intent: string;
  /** Deep-link target when the action is navigation. */
  href?: string;
}

/**
 * The one model every rail consumer reuses. `title` and `body` are already
 * localised server-side (the builder resolves them through the server
 * translator); action labels stay as keys for the client.
 */
export interface PriorityItem {
  kind: PriorityItemKind;
  /**
   * Stable identity for THIS item instance, namespaced `<kind>:...` — present
   * only on the dismissible observational kinds (see
   * `DISMISSIBLE_PRIORITY_ITEM_KINDS`). The client only offers a dismiss
   * affordance when this is set; the actionable kinds never carry one.
   */
  itemKey?: string;
  /** i18n-resolved headline (server-side). */
  title: string;
  /** Optional grounded one-liner — a plain string rendered via `ProseBlocks`. */
  body?: string;
  /** Semantic status wash; omitted for a neutral card. */
  status?: PriorityItemStatus;
  /** 1–3 one-tap actions. Never zero on a live rail item, never more than 3. */
  actions: PriorityItemAction[];
  /** Provenance of the gate that admitted the item, when module-scoped. */
  moduleKey?: ModuleKey;
}

/** Hard cap on one-tap actions per card (P1 anatomy). */
export const MAX_PRIORITY_ACTIONS = 3;
