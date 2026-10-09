import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Reusable empty-state for lists, tiles, and chart panels that have no
 * data yet. Always pair an icon, a one-sentence explanation, and a
 * single primary action. Mounts inside the same container the loaded
 * UI uses so the layout does not shift on first data.
 *
 * Pattern (per `docs/ui-guidelines.md` §4.2):
 *
 *   <EmptyState
 *     icon={<Plus className="size-6" />}
 *     title={t("empty.measurements.title")}
 *     description={t("empty.measurements.description")}
 *     action={<Button>{t("empty.measurements.add")}</Button>}
 *   />
 */
export interface EmptyStateProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /**
   * `"card"` (default) wraps the empty-state in a bordered surface so
   * it sits visually inside a list/tile.
   * `"plain"` renders inline without the wrapper — for use inside
   * chart panels that already have their own card.
   */
  variant?: "card" | "plain";
  /**
   * Compact density for use inside tiles or table-row empty rows.
   */
  size?: "default" | "compact";
}

function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "card",
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  const inner = (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "compact" ? "gap-2 py-4" : "gap-3 py-8",
        // The card variant paints a border, so its content insets from it:
        // a full-width phone CTA otherwise ran edge to edge into the frame.
        variant === "card" && "px-4",
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className={cn(
            "text-muted-foreground bg-muted/60 flex items-center justify-center rounded-full",
            size === "compact" ? "size-8 p-1.5" : "size-12 p-2.5",
          )}
        >
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p
          className={cn(
            "font-medium",
            size === "compact" ? "text-sm" : "text-base",
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="text-muted-foreground max-w-xs text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div
          // One shape for every empty state's action: centred under the
          // copy at its own width, never stretched edge to edge, and on the
          // 44 px tap floor (back to the compact 36 px under a mouse). A
          // per-call-site "lg" variant used to stretch some CTAs full width
          // on a phone and leave others compact, side by side in the app.
          className="mt-1 [&>a]:min-h-11 pointer-fine:[&>a]:min-h-9 [&>button]:min-h-11 pointer-fine:[&>button]:min-h-9"
        >
          {action}
        </div>
      ) : null}
    </div>
  );

  if (variant === "plain") {
    return (
      <div
        data-slot="empty-state"
        role="status"
        aria-live="polite"
        className={cn("w-full", className)}
        {...props}
      >
        {inner}
      </div>
    );
  }

  return (
    <div
      data-slot="empty-state"
      role="status"
      aria-live="polite"
      className={cn(
        "border-border bg-card rounded-xl border border-dashed",
        className,
      )}
      {...props}
    >
      {inner}
    </div>
  );
}

export { EmptyState };
