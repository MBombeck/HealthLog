"use client";

/**
 * The button area of one ask row. One component so the layout of the
 * card's buttons (their width, their column) is a change to this file only.
 *
 * Every row has the same shape: the secondary actions, then the primary one
 * last, on the right, filled. UI standards §12 asks for one primary per
 * card; that rule is written for a card holding one decision (a Settings or
 * Admin card and its one action row). The ask card is a list of separate
 * decisions, each row its own question, so each row carries its own filled
 * primary and its weight matches the row beside it.
 *
 * Layout (variant A): every button the same fixed width, sized to the
 * longest short label in the ten languages (`daily.action.*`, "Skonfiguruj",
 * "Reconnecter"), so the buttons stand in one aligned column on the right of
 * a wide card, the secondary left of the primary. In a narrow card they sit
 * under the text as one row split into equal parts; a single action takes
 * the right part, where the primary stands in every other row.
 */
import type { ReactNode } from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One resolved action: a link, or a button with its handler. */
export type AskAction =
  | { key: string; label: string; href: string }
  | { key: string; label: string; onClick: () => void };

/** The one size every button in the card shares. */
const ACTION_CLASS = "min-h-11 w-full px-2 sm:min-h-9 @min-[44.25rem]:w-28";

export function AskActions({
  actions,
  pending,
}: {
  /** In the server's order: the primary first. */
  actions: AskAction[];
  pending: boolean;
}) {
  if (actions.length === 0) return null;
  const primaryKey = actions[0].key;
  // Shown with the primary last, on the right (UI standards §12).
  const ordered = [...actions].reverse();
  return (
    <div
      data-slot="today-ask-actions"
      className={cn(
        "grid gap-2 @min-[44.25rem]:flex @min-[44.25rem]:shrink-0 @min-[44.25rem]:justify-end",
        ordered.length > 2 ? "grid-cols-3" : "grid-cols-2",
        ordered.length === 1 && "[&>*]:col-start-2",
      )}
    >
      {ordered.map((action) =>
        renderAction(action, action.key === primaryKey, pending),
      )}
    </div>
  );
}

function renderAction(
  action: AskAction,
  primary: boolean,
  pending: boolean,
): ReactNode {
  const variant = primary ? "default" : "outline";
  if ("href" in action) {
    return (
      <Link
        key={action.key}
        href={action.href}
        data-slot="today-ask-action"
        data-primary={primary ? "true" : undefined}
        className={cn(buttonVariants({ variant, size: "sm" }), ACTION_CLASS)}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      key={action.key}
      type="button"
      variant={variant}
      size="sm"
      data-slot="today-ask-action"
      data-primary={primary ? "true" : undefined}
      className={ACTION_CLASS}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={action.onClick}
    >
      {action.label}
    </Button>
  );
}
