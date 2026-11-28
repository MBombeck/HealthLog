"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { useSheetCardMode } from "@/components/settings/sheet-surface";
import { cn } from "@/lib/utils";

/**
 * `<SettingsCard>` — the standard Settings card container.
 *
 * Every Settings section paints the same bordered surface: a rounded card
 * with the app's one card-padding contract (`p-4 md:p-6` — 16 px on phones,
 * 24 px from `md` up). Before this primitive the surface hand-rolled
 * `bg-card border-border rounded-xl border p-4 sm:p-6` in ~35 files, which
 * (a) bypassed the `<Card>` primitive entirely and (b) stepped padding at
 * `sm:` (640 px) instead of `md:` (768 px), so on a ~700 px tablet Settings
 * cards read denser than every other surface.
 *
 * The default renders the ui `<Card>` so the surface composes from one shape,
 * and like `<Card>` the card owns its internal rhythm: `flex flex-col gap-4`.
 * The header→body distance therefore comes from the container's gap, never
 * from a margin a call site remembers to add. It used to come from three
 * competing techniques at once — `mt-4` on the first body child (20 files),
 * `space-y-4` on the card (9), `mb-3`/`mb-4` on the header (2) — which is
 * exactly the drift that made neighbouring cards read as different systems.
 * A denser card overrides the gap on the card itself (`className="gap-2"`),
 * as `<Card>` documents; nothing else may re-declare the header→body step.
 *
 * Pass `className` for per-card extras (`scroll-mt-28`, `flex h-full`, …).
 *
 * `as="section"` keeps a card's semantic landmark element (a `<section>` with
 * an `aria-labelledby`) while painting the same shape, rhythm, and padding.
 *
 * `flush` is for the other body shape: an edge-to-edge `divide-y` ledger whose
 * rows carry their own inset. Such a card drops BOTH the padding and the gap.
 * Dropping only the padding is the trap — the gap survives as dead,
 * unclickable space between the rows that the first row does not have, so the
 * list reads a step off itself. `<InsightSectionCard flush>` names the same
 * shape on the Insights side.
 */
const SETTINGS_CARD_SHELL = "flex flex-col gap-4 p-4 md:p-6";
// Both breakpoints are named explicitly: the `<Card>` primitive carries
// `md:gap-6` / `md:py-6`, and a bare `gap-0` / `p-0` loses to a `md:` variant
// from `md` up — which is exactly the width the dead space showed at.
const SETTINGS_CARD_FLUSH_SHELL =
  "flex flex-col gap-0 overflow-hidden p-0 md:gap-0 md:p-0";

type SettingsCardOwnProps = { className?: string; flush?: boolean };

type SettingsCardProps<E extends React.ElementType> = SettingsCardOwnProps & {
  as?: E;
} & Omit<React.ComponentPropsWithoutRef<E>, keyof SettingsCardOwnProps | "as">;

export function SettingsCard<E extends React.ElementType = typeof Card>({
  as,
  className,
  flush = false,
  ...props
}: SettingsCardProps<E>) {
  // Inside an integration sheet the sheet is the frame: the card keeps its
  // content and drops its own border and padding.
  const sheetMode = useSheetCardMode();
  if (sheetMode) {
    return (
      <div
        data-slot="card"
        data-surface="sheet"
        className={cn("flex flex-col gap-4", className)}
        {...(props as React.ComponentProps<"div">)}
      />
    );
  }
  if (as) {
    const Component = as as React.ElementType;
    return (
      <Component
        data-slot="card"
        // Mirror the ui Card shell so a semantic landmark card paints
        // identically to the default <Card>-backed one.
        className={cn(
          "bg-card text-card-foreground rounded-xl border shadow-sm",
          flush
            ? SETTINGS_CARD_FLUSH_SHELL
            : "flex flex-col gap-4 p-4 md:gap-6 md:p-6",
          className,
        )}
        {...props}
      />
    );
  }
  return (
    <Card
      // Reset the primitive's flex/gap layout and apply the shared
      // `p-4 md:p-6` padding; Settings bodies own their internal spacing.
      className={cn(
        flush ? SETTINGS_CARD_FLUSH_SHELL : SETTINGS_CARD_SHELL,
        className,
      )}
      {...(props as React.ComponentProps<typeof Card>)}
    />
  );
}
