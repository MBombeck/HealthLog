import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Navigation between the sub-pages of one area: the Insights pages, the
 * sections of a console. A row of pills that scrolls sideways when it runs
 * out of room, the current page's pill tinted in the primary colour.
 *
 * The same job had four looks: these pills on Insights, a second set of
 * pills in another size and tint, a card that switched sections, and a
 * muted track with a raised segment. A person moving from one area to the
 * next met a different control for "the other pages here" each time.
 *
 * This is for pages with an address of their own. A choice between views
 * inside one page is `Segmented`, or `Tabs` when each view is a panel; both
 * fill the chosen one in the primary colour and paint no track.
 */

/** One pill: 44 px tall, the current one tinted. */
export function subNavItemClass(active: boolean): string {
  return cn(
    "inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
    "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
    active
      ? "border-primary bg-primary/10 text-primary"
      : "border-border text-muted-foreground hover:text-foreground",
  );
}

/**
 * The row the pills stand in. It scrolls sideways without a scrollbar and
 * leaves the vertical pan to the page.
 *
 * `overflow-x-auto` clips vertically too, so a pill's border on the edge of
 * the box lost a pixel at fractional zoom and the focus ring was cut on
 * every side. `px-1 py-1` keeps 4 px of paint room inside the clip box and
 * the matching `-mx-1 -my-1` gives it back to the layout.
 */
export function SubNavRow({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sub-nav-row"
      className={cn(
        "scroll-touch -mx-1 -my-1 flex min-w-0 [scrollbar-width:none] gap-2 overflow-x-auto px-1 py-1 [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    />
  );
}

/** A pill that leads to a sub-page and says when it is the current one. */
export function SubNavLink({
  active,
  className,
  ...props
}: React.ComponentProps<typeof Link> & { active: boolean }) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      data-active={active ? "true" : undefined}
      className={cn(subNavItemClass(active), className)}
      {...props}
    />
  );
}
