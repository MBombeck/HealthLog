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
 * The pair is the shared `ActionPair`, with one rule of its own: in a wide
 * card every button has the same fixed width, sized to the longest short
 * label in the ten languages (`daily.action.*`, "Skonfiguruj",
 * "Reconnecter"), so the buttons of all rows stand in one aligned column on
 * the right. In a narrow card they sit under the text as one row split in
 * halves; a single action takes the right half, where the primary stands in
 * every other row.
 */
import type { ReactNode } from "react";
import Link from "next/link";

import { ActionPair } from "@/components/ui/action-pair";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** One resolved action: a link, or a button with its handler. */
export type AskAction =
  | { key: string; label: string; href: string }
  | { key: string; label: string; onClick: () => void };

/** The button's height; the pair owns its width. */
const ACTION_CLASS = "min-h-11 px-2 sm:min-h-9";

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
    <ActionPair
      data-slot="today-ask-actions"
      className="@min-[44.25rem]:w-auto @min-[44.25rem]:shrink-0"
      pairClassName="w-full grid-cols-2 *:only:col-start-2 @min-[44.25rem]:w-max @min-[44.25rem]:grid-cols-none @min-[44.25rem]:auto-cols-[7rem]"
    >
      {ordered.map((action) =>
        renderAction(action, action.key === primaryKey, pending),
      )}
    </ActionPair>
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
