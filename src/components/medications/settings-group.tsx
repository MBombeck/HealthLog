"use client";

/**
 * v1.7.0 — advanced-settings group header.
 * v1.8.6 — rebuilt as a bordered section card. The sheet now stacks
 * every group in a single column (Reminders → Lifecycle → Data →
 * Danger), so each group needs its own frame to read as a distinct
 * block rather than a hairline-separated run. The card owns one spacing
 * rule: an uppercase micro-label header, then a `divide-y` body where
 * each row carries `py-3`. Callers pass one `<div>` per row; the card
 * supplies the dividers so no row interleaves its own `<Separator>`.
 *
 * The label is a plain `<p>` (not a heading with an id) so it stays out
 * of the `aria-labelledby` graph — the sheet already owns the dialog
 * title, and the inner switch labels carry their own ids. This avoids
 * the duplicate-id axe failure the section-card heading split guards
 * against.
 *
 * v1.18.5 — opt-in collapsible mode. When `collapsible` is set the
 * uppercase micro-label becomes a Radix Collapsible trigger (the same
 * primitive `SheetSection` uses) with a rotating chevron, so a long
 * advanced-settings surface reads as scannable expand/collapse groups
 * instead of one wall of stacked rows. The non-collapsible default keeps
 * the static `<p>` header for the sheet callers. The settings inside are
 * unchanged either way.
 */

import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

export interface SettingsGroupProps {
  label: ReactNode;
  children: ReactNode;
  dataSlot?: string;
  className?: string;
  /** v1.18.5 — render the group as an expand/collapse section. */
  collapsible?: boolean;
  /** Whether a collapsible group starts expanded (uncontrolled, default true). */
  defaultOpen?: boolean;
}

export function SettingsGroup({
  label,
  children,
  dataSlot,
  className,
  collapsible = false,
  defaultOpen = true,
}: SettingsGroupProps) {
  if (!collapsible) {
    return (
      <section
        className={cn("bg-card rounded-lg border px-4 py-1", className)}
        {...(dataSlot ? { "data-slot": dataSlot } : {})}
      >
        <p className="text-muted-foreground border-border/60 border-b py-2.5 text-xs font-medium">
          {label}
        </p>
        <div className="divide-border/60 divide-y">{children}</div>
      </section>
    );
  }

  return (
    <CollapsiblePrimitive.Root
      defaultOpen={defaultOpen}
      className={cn("bg-card rounded-lg border px-4 py-1", className)}
      {...(dataSlot ? { "data-slot": dataSlot } : {})}
    >
      <CollapsiblePrimitive.Trigger
        data-slot="settings-group-trigger"
        className="group focus-visible:ring-ring/50 border-border/60 flex w-full items-center gap-2 border-b py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="text-muted-foreground flex-1 text-xs font-medium">
          {label}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content
        data-slot="settings-group-content"
        className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden motion-reduce:animate-none"
      >
        <div className="divide-border/60 divide-y">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}
