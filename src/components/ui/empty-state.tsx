import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one empty state: a title and, when there is something to do, the
 * action that does it. One row, the height of the rows it stands in for.
 *
 * It used to say the same thing three times: a page subtitle explained the
 * page, the empty title said there was nothing, and a sentence under it
 * explained the page again, often beside a button with the same words. The
 * title names what is missing ("No vaccination recorded yet"), the action is
 * the next step, and nothing else is written. A reason that has to stand
 * (a safety or a consent line) belongs to the surface around it as a `Hint`,
 * not to the empty state.
 *
 *   <EmptyState
 *     icon={<Syringe className="size-4" />}
 *     title={t("vaccinations.emptyTitle")}
 *     action={<Button size="sm">{t("vaccinations.add")}</Button>}
 *   />
 *
 * `meta` is the row's one meta line, for a value that is still being learned:
 * how far it has come ("5 of 20 paired days", "3 more readings"). A number
 * and its unit, never a sentence that explains the page.
 *
 * `"card"` (default) puts the row in a card of its own, for a page or a
 * section that has nothing yet. `"plain"` renders the bare row, inside a card
 * or a chart panel that already has its frame. Inside a `ListGroup`, use its
 * `empty` row instead: an add row is the empty state of a list.
 */
export interface EmptyStateProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** One meta line: the progress of a value still being learned. */
  meta?: React.ReactNode;
  action?: React.ReactNode;
  variant?: "card" | "plain";
}

function EmptyState({
  icon,
  title,
  meta,
  action,
  variant = "card",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      data-variant={variant}
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-14 w-full flex-wrap items-center gap-x-3 gap-y-2 py-2",
        variant === "card"
          ? "bg-card text-card-foreground rounded-xl border px-4 shadow-sm"
          : "px-0",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          data-slot="empty-state-icon"
          className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4"
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p data-slot="empty-state-title" className="text-sm font-medium">
          {title}
        </p>
        {meta ? (
          <p
            data-slot="empty-state-meta"
            className="text-muted-foreground text-xs"
          >
            {meta}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          data-slot="empty-state-action"
          // 44 px under a finger, 36 px under a mouse, whatever the call
          // site's button size.
          className="flex shrink-0 items-center gap-2 [&>a]:min-h-11 pointer-fine:[&>a]:min-h-9 [&>button]:min-h-11 pointer-fine:[&>button]:min-h-9"
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}

export { EmptyState };
