"use client";

/**
 * The rail's destination list: its row primitives, one destination row, and
 * the list under its group headings (`NAV_GROUPS`, #1113).
 *
 * Expanded, each group but the top one has a plain heading, never a control.
 * Collapsed, a hairline stands where the heading was and the heading stays
 * for screen readers; every icon keeps its tooltip and accessible name. A
 * group whose entries are all switched off is not drawn at all.
 */
import Link from "next/link";
import { useId } from "react";

import {
  groupNavDestinations,
  isNavDestinationActive,
  type NavDestination,
} from "@/components/layout/nav-model";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "@/lib/i18n/context";
import type { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import { cn } from "@/lib/utils";

/**
 * Height-based density for the rail. A 13-inch laptop at 100 % zoom leaves
 * the browser roughly 700–860 px, and the full destination list plus the
 * footer rows did not fit: the list scrolled, and on a classic-scrollbar
 * platform (Windows) the rail grew a native scrollbar with arrow buttons.
 * On short windows the rows close their gaps first, then step their height
 * down; tall windows keep the roomy default. Desktop-only by construction —
 * the rail is hidden below `md`, so the phone layout never sees these steps.
 *
 * Steps (rows are full-width, so the click target is the whole row):
 * - default: 40 px rows, 4 px apart
 * - max-height 940 px: gaps close (40 px pitch), the list padding tightens
 *   (the account band keeps the logo band's height, `RAIL_ACCOUNT_BAND`)
 * - max-height 820 px: 36 px rows, the group headings close up
 * - max-height 780 px: 28 px rows and the headings at their line height.
 *   A 1366 × 768 window has 640 px between the logo band and the account
 *   band, and the whole rail with every module on (17 destinations under
 *   three headings, then Collapse, Admin and Settings) needs 636 of them
 *   at this step; a 32 px row already leaves no room for the headings.
 *   Taken only where the alternative is rows hidden behind a scroll edge.
 */
// Disjoint height ranges, not nested max-heights: two arbitrary media
// variants on one property cascade in stylesheet order, not by how narrow
// the query is, so a nested pair let the 36 px step win on a 720 px window.
// The height steps apply to a mouse only. Under a finger (a touch tablet)
// the rows keep the 44 px touch floor and the list scrolls behind its fades
// instead. A phone held sideways never sees the rail: it keeps the phone
// shell (`shell-mobile`).
export const RAIL_ROW_HEIGHT =
  "min-h-10 pointer-coarse:min-h-11 [@media(hover:hover)_and_(pointer:fine)_and_(780px<height<=820px)]:min-h-9 [@media(hover:hover)_and_(pointer:fine)_and_(height<=780px)]:min-h-7";
/**
 * An expanded row's own padding, which sets its height wherever the floor
 * above is lower: a 20 px label plus 6 px each side is 32 px, so the 28 px
 * step drops the padding to 4 px. A finger keeps the 44 px floor regardless.
 */
const RAIL_ROW_PY = "py-1.5 [@media(height<=780px)]:py-1";
/**
 * The space above an expanded group's heading, and under it. Disjoint ranges
 * for the same reason as the row heights.
 */
const RAIL_GROUP_GAP =
  "mt-4 [@media(780px<height<=820px)]:mt-2 [@media(height<=780px)]:mt-1";
const RAIL_HEADING_PB = "pb-1 [@media(height<=780px)]:pb-0";
export const RAIL_LIST_GAP = "space-y-1 [@media(max-height:940px)]:space-y-0";
export const RAIL_SHORT_PY = "[@media(max-height:940px)]:py-1.5";

/** Rail row, collapsed (icon only) or expanded (icon + label). */
export function railRowClass(collapsed: boolean): string {
  return cn(
    "flex items-center rounded-lg transition-colors",
    RAIL_ROW_HEIGHT,
    collapsed
      ? "justify-center px-2.5"
      : cn("gap-3 px-3 text-sm font-medium", RAIL_ROW_PY),
  );
}

/**
 * One destination in the rail. Collapsed, only the icon shows and the label
 * moves into a hover tooltip, so the link carries the label as its accessible
 * name: a tooltip exists only while hovered and names nothing. A count above
 * zero sits at the row's end (on the icon when collapsed) and joins the name.
 */
function RailNavLink({
  href,
  label,
  icon: Icon,
  tourId,
  collapsed,
  active,
  count,
  intent,
}: {
  href: string;
  label: string;
  icon: NavDestination["icon"];
  tourId?: string;
  collapsed: boolean;
  active: boolean;
  count: number;
  intent?: ReturnType<typeof medicationsPrefetchIntentProps>;
}) {
  const { t } = useTranslations();
  const name = count > 0 ? t("nav.dueCount", { label, count }) : label;
  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed || count > 0 ? name : undefined}
      data-tour-id={tourId}
      {...intent}
      className={cn(
        railRowClass(collapsed),
        "relative",
        active
          ? "bg-primary/10 text-primary"
          : "text-foreground hover:bg-accent",
      )}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      {collapsed ? null : label}
      {count > 0 ? (
        <span
          aria-hidden="true"
          data-slot="nav-count"
          className={cn(
            "bg-primary text-primary-foreground text-2xs h-4 min-w-4 rounded-full px-1 text-center leading-4 font-semibold tabular-nums",
            collapsed
              ? "ring-sidebar absolute top-0.5 right-1.5 ring-2"
              : "ml-auto",
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

/** The destinations under their group headings. */
export function RailNavGroups({
  items,
  pathname,
  collapsed,
  counts,
  medsIntent,
}: {
  items: ReadonlyArray<NavDestination>;
  pathname: string;
  collapsed: boolean;
  counts: Readonly<Record<string, number>>;
  medsIntent: ReturnType<typeof medicationsPrefetchIntentProps>;
}) {
  const { t } = useTranslations();
  const id = useId();
  return (
    <>
      {groupNavDestinations(items).map((group, index) => {
        const headingId = `${id}-${group.id}`;
        return (
          <div
            key={group.id}
            role={group.labelKey ? "group" : undefined}
            aria-labelledby={group.labelKey ? headingId : undefined}
            data-slot="nav-group"
            data-group={group.id}
            className={cn(
              RAIL_LIST_GAP,
              index > 0 &&
                (collapsed
                  ? "before:bg-sidebar-border relative mt-2 pt-2 before:absolute before:inset-x-2.5 before:top-0 before:h-px"
                  : RAIL_GROUP_GAP),
            )}
          >
            {group.labelKey ? (
              <div
                id={headingId}
                data-slot="nav-group-heading"
                className={
                  collapsed
                    ? "sr-only"
                    : cn(
                        "text-muted-foreground px-3 text-xs font-medium tracking-wide uppercase",
                        RAIL_HEADING_PB,
                      )
                }
              >
                {t(group.labelKey)}
              </div>
            ) : null}
            {group.items.map((item) => (
              <RailNavLink
                key={item.href}
                href={item.href}
                label={t(item.tKey)}
                icon={item.icon}
                tourId={item.tourId}
                collapsed={collapsed}
                active={isNavDestinationActive(item.href, pathname, items)}
                count={counts[item.href] ?? 0}
                intent={item.href === "/medications" ? medsIntent : undefined}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
