"use client";

import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useTargetAdjust } from "@/lib/insights/target-adjust-context";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";

/**
 * Header gear that opens the per-metric target editor.
 *
 * The "Adjust target range" affordance used to sit inside the target
 * reference card; it now lives in the Insights category-page header
 * (`<SubPageShell>`), to the left of the Coach launch icon, so the card
 * stays a read surface. The button is a thin wrapper around
 * `useTargetAdjust()`:
 *
 *   - renders nothing when no provider is mounted or no editable target
 *     has registered for the page (e.g. a metric without a numeric
 *     target band, where the card paints nothing), so the header never
 *     shows a dead control;
 *   - renders nothing inside somebody else's record: the editor loads and
 *     saves the signed-in account's own targets (`/api/user/thresholds`),
 *     which refuses under a switch, so the gear would open a sheet that
 *     can do neither;
 *   - opens the primary registered target's `<TargetEditSheet>` on click.
 *
 * Sized to match `<CoachLaunchButton variant="icon">` so the gear + the
 * Coach sparkle read as a consistent icon cluster top-right of the
 * heading.
 */
export function TargetAdjustButton({ className }: { className?: string }) {
  const { t } = useTranslations();
  const adjust = useTargetAdjust();
  const { inSharedRecord } = useRecordCapabilities();

  // No provider, no editable target registered for this page, or a record
  // whose targets this editor cannot reach.
  if (!adjust || !adjust.canAdjust || inSharedRecord) return null;

  // Reuse the action's existing copy ("Adjust target range" /
  // "Zielbereich anpassen") — the gear performs exactly what the old
  // in-card link did, so the same string is the right accessible label.
  const label = t("insights.subPage.target.adjustLink");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot="target-adjust-trigger"
      aria-label={label}
      title={label}
      onClick={() => adjust.requestAdjust()}
      className={cn(
        // The `icon` size is a flat 40 px — identical to the sibling Coach
        // sparkle icon — so the gear + Coach read as one even-weighted icon
        // cluster top-right of the heading on every breakpoint.
        //
        // The 40 px visual box is below the WCAG 2.5.5 (44 px) floor, so a
        // transparent `::before` overlay extends the *hit* area by 6 px on
        // every side (40 + 2×6 = 52 px) without enlarging the painted box.
        // This keeps the touch target comfortable while the gear stays
        // visually equal to the Coach icon.
        "text-muted-foreground hover:text-foreground relative size-10",
        "before:absolute before:-inset-1.5 before:content-['']",
        className,
      )}
    >
      <Settings2 className="size-4" aria-hidden="true" />
    </Button>
  );
}
