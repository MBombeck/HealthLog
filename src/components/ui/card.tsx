import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * v1.4.33 — Card padding normalised on `p-4 md:p-6`.
 *
 * Pre-v1.4.33 the shadcn defaults shipped `py-6` + `px-6` (uniform
 * 24 px on every breakpoint) while the dashboard tile-strip + chart
 * cards used `p-4 md:p-6` (16 px mobile, 24 px md+). Side-by-side on
 * `/insights` the correlation cards + daily-briefing read as "denser"
 * than the chart cards next to them; the visual reads as two card
 * languages on the same page. Matching the dashboard token here gives
 * the whole app a single card-padding contract.
 */
/**
 * The two card densities (UI standards §1) live here, not at the call site:
 * `default` is the card as shipped, `compact` is the stat-strip and
 * small-tile rhythm. Spelled by hand as `gap-2 py-3 md:py-4`, the compact
 * tier kept the base `md:gap-6`, so nineteen "compact" cards opened a 24 px
 * gap between header and body on a desktop. The prop pins both breakpoints.
 */
const CARD_DENSITY = {
  default: "",
  compact: "gap-2 py-3 md:gap-2 md:py-4",
} as const;

function Card({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"div"> & { density?: keyof typeof CARD_DENSITY }) {
  return (
    <div
      data-slot="card"
      data-density={density === "default" ? undefined : density}
      className={cn(
        "bg-card text-card-foreground flex flex-col gap-4 rounded-xl border py-4 shadow-sm md:gap-6 md:py-6",
        CARD_DENSITY[density],
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min items-start gap-2 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] md:px-6 [.border-b]:pb-4 md:[.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "leading-tight font-semibold break-words hyphens-auto",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-full row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4 md:px-6", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center px-4 md:px-6 [.border-t]:pt-4 md:[.border-t]:pt-6",
        className,
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
