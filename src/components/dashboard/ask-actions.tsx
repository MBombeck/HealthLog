"use client";

/**
 * The button pair of one ask row, at the right end of the row at every
 * width. One component so the pair's look is a change to this file only.
 *
 * The quiet pair of the button primitives: the primary action `tonal` (the
 * accent at a tenth, accent text), the secondary ("Later", or "No" on a
 * consent) `neutral` (a grey fill, foreground text), both filled, neither
 * framed; the primary stands last, on the right. No button in the card is filled: each row is
 * its own decision with its own primary (the stated exception to UI
 * standards §12), and a column of filled buttons outweighed the page's one
 * filled action, "Add". Both are the `compact` size: a 32 px face with a
 * 44 px target.
 *
 * Width: the pair is a two-column grid of equal halves inside the card's
 * last column (`TodayAsks`), which is as wide as the widest pair in the
 * card. So both buttons of a row are one width, every row's buttons stand in
 * one column, and that width is the widest label in this card in this
 * language plus the button's padding: no fixed width wasted on short labels,
 * no long label clipped. A single action takes the right half, where the
 * primary stands in every other row.
 */
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One resolved action: a link, or a button with its handler. */
export type AskAction =
  | { key: string; label: string; href: string }
  | { key: string; label: string; onClick: () => void };

/** Larger labels and padding once the card has room (`TodayAsks`' query). */
const ACTION_CLASS =
  "w-full @min-[44.25rem]:min-w-24 @min-[44.25rem]:px-3 @min-[44.25rem]:text-sm";

export function AskActions({
  actions,
  pending,
  describedBy,
}: {
  /** In the server's order: the primary first. */
  actions: AskAction[];
  pending: boolean;
  /** The row's title, so "Later" is announced with what it defers. */
  describedBy?: string;
}) {
  if (actions.length === 0) return null;
  const primaryKey = actions[0].key;
  // Shown with the primary last, on the right (UI standards §12).
  const ordered = [...actions].reverse();
  return (
    <div
      data-slot="today-ask-actions"
      className="grid grid-cols-[1fr_1fr] gap-2 *:only:col-start-2"
    >
      {ordered.map((action) => {
        const primary = action.key === primaryKey;
        const variant = primary ? "tonal" : "neutral";
        const common = {
          "data-slot": "today-ask-action",
          "data-primary": primary ? "true" : undefined,
          "aria-describedby": describedBy,
        };
        return "href" in action ? (
          <Link
            key={action.key}
            href={action.href}
            {...common}
            className={cn(
              buttonVariants({ variant, size: "compact" }),
              ACTION_CLASS,
            )}
          >
            {action.label}
          </Link>
        ) : (
          <Button
            key={action.key}
            type="button"
            variant={variant}
            size="compact"
            {...common}
            className={ACTION_CLASS}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}
