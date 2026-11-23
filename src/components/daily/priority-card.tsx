"use client";

/**
 * `PriorityCard`, the ONE card behind every "worth a look" rail item.
 *
 * It renders a `PriorityItem` and never fetches. Every later consumer reuses
 * it verbatim: the Today rail (S2), a coach check-in (S3), a milestone
 * celebration (S12), a new-ECG pointer (S10), a tension window (S11). A new
 * rail type is a new `kind` on the item + a server builder — never a new
 * component (§1.2 P1).
 *
 * Design: composed ENTIRELY from shipped primitives — `Card` (compact
 * density) + `TileHeader` (size `sm`, foreground icon) + `ProseBlocks` for the
 * grounded one-liner, semantic-token status wash only, no raw palette colour
 * (the `no-raw-palette-color` rule errors), no markdown. The Lucide glyph is
 * derived from `kind` so the wire DTO stays serialisable (the icon lives with
 * the renderer, the closed enum with the model). The `animate-insight-in`
 * reveal carries its own reduced-motion fallback in `globals.css`.
 */
import Link from "next/link";
import {
  Activity,
  CalendarCheck,
  Award,
  CalendarClock,
  Footprints,
  HeartPulse,
  MessageCircle,
  Pill,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { Button, buttonVariants } from "@/components/ui/button";
import { VISITS_PATH } from "@/lib/encounters/visit-links";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  isDismissibleKind,
  type PriorityItem,
  type PriorityItemAction,
  type PriorityItemKind,
  type PriorityItemStatus,
} from "@/lib/daily/priority-item";

/** Deterministic glyph per kind — the icon the serialisable item cannot hold. */
const KIND_ICON: Record<PriorityItemKind, LucideIcon> = {
  dose_window: Pill,
  preventive_care: CalendarClock,
  sync_issue: RefreshCw,
  coach_checkin: MessageCircle,
  milestone: Award,
  ecg_new_recording: HeartPulse,
  tension_window: Activity,
  same_time_baseline: Footprints,
  upcoming_visit: CalendarCheck,
};

/**
 * Status wash — a subtle semantic-token tint carrying MEANING, not decoration
 * (the `recommendation-card` pattern). Static classes so Tailwind sees them.
 */
const STATUS_WASH: Record<PriorityItemStatus, string> = {
  success: "bg-success/10 border-success/25",
  warning: "bg-warning/10 border-warning/25",
  info: "bg-info/10 border-info/25",
  destructive: "bg-destructive/10 border-destructive/25",
};

/**
 * v1.29.0 cohesion — per-kind metric identity, drawn from the SAME `--tile-*`
 * hue vocabulary the wellness tiles paint (plus `--primary` for the med and
 * coach families, the tone every medication / coach surface in Insights
 * already carries). Rendered as the `.metric-accent` inset edge — a quiet
 * identity mark, never a fill — so a pulse card, an ECG card, and a dose card
 * each read as their metric family while staying one card system.
 *
 * Deliberately partial: `preventive_care` and `sync_issue` are utility items
 * with no metric family, and `milestone` belongs to the celebration layer
 * (`.milestone-reached`, `--success`) rather than to one metric — those three
 * stay accent-less. Values are token references only (`var(--…)`), the
 * `RingTile` / `TILE_HUE` pattern.
 */
const KIND_HUE: Partial<Record<PriorityItemKind, string>> = {
  dose_window: "var(--primary)",
  coach_checkin: "var(--primary)",
  ecg_new_recording: "var(--tile-strain)",
  tension_window: "var(--tile-stress)",
};

export interface PriorityCardProps {
  item: PriorityItem;
  /**
   * Tap handler for non-navigation actions. Receives the action's stable
   * `intent` token. Navigation actions (those carrying an `href`) render as
   * links and do not call this.
   *
   * Omitting it does not render an inert button: an action with no `href` and
   * no handler is not offered at all. A button whose only job is to call a
   * handler nobody passed is a control that says "this works" and does
   * nothing, which is the one outcome worse than a refusal.
   */
  onAction?: (intent: string) => void;
  /**
   * Dismiss handler for the OBSERVATIONAL kinds only (`milestone`,
   * `ecg_new_recording`, `tension_window`). Receives the item's own
   * `itemKey`. The card renders the affordance ONLY when the kind is
   * dismissible AND the item actually carries a key — an actionable item (no
   * `itemKey` by construction) never shows one, no matter what the caller
   * passes.
   */
  onDismiss?: (itemKey: string) => void;
  /**
   * True while a non-navigation action on THIS card has a mutation in
   * flight (e.g. the coach check-in's keep/let-go). Disables the
   * button-rendered actions (`aria-busy` + `disabled`) so a slow round trip
   * can't be double-tapped into firing the mutation twice; pure `href`
   * actions stay live since they're navigation, not a mutation.
   */
  actionsPending?: boolean;
  className?: string;
}

/** Tap-target floor per P1: `min-h-11` on touch, `min-h-9` on pointer. */
const ACTION_SIZE = "min-h-11 sm:min-h-9";

export function PriorityCard({
  item,
  onAction,
  onDismiss,
  actionsPending,
  className,
}: PriorityCardProps) {
  const { t } = useTranslations();
  const Icon = KIND_ICON[item.kind];
  // Navigation always survives; a mutating action survives only when somebody
  // is there to run it. That is what removes the whole non-navigation half of
  // this card inside a record the caller may not change, without this file
  // learning anything about grants.
  const actions = item.actions
    .filter((action) => action.href || onAction)
    .slice(0, 3);
  const hue = KIND_HUE[item.kind];
  // The quiet "reached" moment: the milestone card swaps the generic
  // fade-in for the `.milestone-reached` treatment (a soft `--success` halo
  // over the theme card + a one-shot spring reveal on `--ring-spring`;
  // reduced-motion fallback lives beside the keyframes in globals.css). The
  // halo's background wins over the status wash's flat `bg-success/10`
  // (unlayered CSS beats utilities); the wash keeps the success border.
  const isMilestone = item.kind === "milestone";
  // Dismiss is offered ONLY on the observational kinds, and only once the
  // server has actually stamped an identity onto this instance — the
  // actionable kinds never carry an `itemKey`, so this is structurally false
  // for them regardless of what the caller wires up. Held as its own const
  // (rather than re-checked inline) so the narrowed `string` type carries
  // into the click handler below without a non-null assertion.
  const dismissKey = isDismissibleKind(item.kind) ? item.itemKey : undefined;

  return (
    <Card
      data-slot="priority-card"
      data-kind={item.kind}
      density="compact"
      className={cn(
        isMilestone ? "milestone-reached" : "animate-insight-in",
        item.status ? STATUS_WASH[item.status] : null,
        hue ? "metric-accent" : null,
        className,
      )}
      style={hue ? ({ "--tile-hue": hue } as React.CSSProperties) : undefined}
    >
      <CardContent className="flex flex-col gap-2">
        <TileHeader
          icon={Icon}
          title={item.title}
          size="sm"
          right={
            dismissKey && onDismiss ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-slot="priority-card-dismiss"
                className="text-muted-foreground hover:text-foreground -my-2 -mr-2 min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                onClick={() => onDismiss(dismissKey)}
                aria-label={t("common.dismiss")}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            ) : undefined
          }
        />
        {item.body ? (
          <div className="text-foreground text-sm">
            <ProseBlocks text={item.body} strip={false} linkify={false} />
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {actions.map((action) =>
              action.href ? (
                <ActionLink
                  key={action.intent}
                  href={action.href}
                  label={t(actionLabelKey(item, action))}
                />
              ) : onAction ? (
                <ActionButton
                  key={action.intent}
                  action={action}
                  label={t(action.labelKey)}
                  onAction={onAction}
                  pending={actionsPending}
                />
              ) : null,
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A navigation action. Always offered — reading is never delegated away. */
/**
 * The label key a web card shows for an action.
 *
 * The server's `labelKey`, except on an appointment: that item still carries
 * the check-up item's label key on the wire (`daily.action.viewCheckups`), because the
 * shipped iOS app resolves the label and routes the intent it already knows.
 * Its `href` already opens the visit, so the web names what it opens.
 */
export function actionLabelKey(
  item: Pick<PriorityItem, "kind">,
  action: Pick<PriorityItemAction, "labelKey" | "href">,
): string {
  if (item.kind !== "upcoming_visit" || !action.href) return action.labelKey;
  return action.href === VISITS_PATH
    ? "daily.action.viewAppointments"
    : "daily.action.viewAppointment";
}

function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        ACTION_SIZE,
      )}
    >
      {label}
    </Link>
  );
}

/**
 * A mutating action. `onAction` is required rather than optional so the type
 * carries the rule: this button cannot be rendered without the handler that
 * makes it do something.
 */
function ActionButton({
  action,
  label,
  onAction,
  pending,
}: {
  action: PriorityItemAction;
  label: string;
  onAction: (intent: string) => void;
  pending?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={ACTION_SIZE}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => onAction?.(action.intent)}
    >
      {label}
    </Button>
  );
}
