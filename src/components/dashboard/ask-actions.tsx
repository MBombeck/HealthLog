"use client";

/**
 * The button pair of one ask row, at the right end of the row at every
 * width: the shared `ActionPair` in its `compact` variant, so the look (a
 * grey secondary, a tonal primary, no frames, the `compact` size) is the
 * pair's, not this card's (UI standards §15). The primary stands last, on
 * the right. Each row is its own decision with its own primary, the stated
 * exception to §12's one primary per card.
 *
 * Width: the pair fills the card's last column (`TodayAsks`), which is as
 * wide as the widest pair in the card, so both buttons of a row are one
 * width and every row's buttons stand in one column.
 */
import Link from "next/link";

import { ActionPair, actionPairButton } from "@/components/ui/action-pair";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One resolved action: a link, or a button with its handler. */
export type AskAction =
  | { key: string; label: string; href: string }
  | { key: string; label: string; onClick: () => void };

/** Larger labels and padding once the card has room (`TodayAsks`' query). */
const WIDE_CLASS =
  "@min-[44.25rem]:min-w-24 @min-[44.25rem]:px-3 @min-[44.25rem]:text-sm";

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
    <ActionPair variant="compact" data-slot="today-ask-actions">
      {ordered.map((action) => {
        const primary = action.key === primaryKey;
        const look = actionPairButton(
          "compact",
          primary ? "primary" : "secondary",
        );
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
            className={cn(buttonVariants(look), WIDE_CLASS)}
          >
            {action.label}
          </Link>
        ) : (
          <Button
            key={action.key}
            type="button"
            {...look}
            {...common}
            className={WIDE_CLASS}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        );
      })}
    </ActionPair>
  );
}
