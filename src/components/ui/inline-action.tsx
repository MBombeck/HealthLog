import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A small text action that sits inside a line of content: "Open schedule"
 * beside a value, "Select all" beside a group label, "View all" in a card
 * header, a "Learn more" link under a hint. Not a button with a frame (that
 * is `Button`), not a content link inside prose.
 *
 * It owns three things the hand-rolled copies kept getting wrong:
 *
 * - **The touch target.** On a coarse pointer the action answers a tap
 *   across 44 px of height, through a hit area that takes no room: an
 *   absolutely placed `::before`, centred on the text. The action itself
 *   stays one line of text tall. It used to grow to 44 px
 *   (`pointer-coarse:min-h-11`), so a 12 px link at the end of a card left
 *   twice the card's padding under it, and a link inside a sentence opened
 *   that line to 44 px. A fine pointer has no hit area beyond the text.
 * - **The focus ring**, which several copies had none of.
 * - **The tone vocabulary**: `primary` for the one forward action of a row,
 *   `muted` for a secondary way out, `foreground` for an action that reads as
 *   part of the content.
 *
 * Render a `Link` or `<a>` through `asChild`. A plain button gets
 * `type="button"` so it never submits the form it sits in.
 */
const inlineActionVariants = cva(
  "relative inline-flex items-center gap-1 rounded-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      tone: {
        primary: "text-primary",
        muted: "text-muted-foreground hover:text-foreground",
        foreground: "text-foreground/80 hover:text-foreground",
      },
      size: {
        xs: "text-xs",
        sm: "text-sm",
      },
    },
    defaultVariants: {
      tone: "primary",
      size: "xs",
    },
  },
);

type InlineActionProps = React.ComponentProps<"button"> &
  VariantProps<typeof inlineActionVariants> & {
    asChild?: boolean;
  };

function InlineAction({
  className,
  tone,
  size,
  asChild = false,
  type,
  ...props
}: InlineActionProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="inline-action"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(inlineActionVariants({ tone, size }), className)}
      {...props}
    />
  );
}

export { InlineAction, inlineActionVariants };
