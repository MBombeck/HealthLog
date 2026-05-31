"use client";

/**
 * v1.5.5 D-3 §9.1 — medication-detail page header band.
 *
 * Renders the drug name as the H1, dose as a muted sub-line, and a
 * status row carrying a Dracula-token dot + always-visible label
 * (Aktiv / Pausiert / Beendet) and a three-button action row: Edit
 * (pencil, opens the wizard at Step 1), History (clock, routes to the
 * full intake-history view) and Advanced (sliders, opens the advanced
 * settings sheet). The DOM order is `name → dose → status → edit →
 * history → advanced` so the screen reader announces the drug first
 * and the affordances last (C-E4-3).
 *
 * The status pill text is always rendered; the dot carries
 * `aria-hidden="true"` and reads from Dracula tokens via
 * `bg-[hsl(var(--success))]` / `bg-[hsl(var(--warning))]` /
 * `bg-muted-foreground`. The "since DD.MM." drift the earlier draft
 * mixed into the header is dropped — lifecycle dates live on the
 * destructive zone, not on the header (E-2 M-1).
 */

import { History, Pencil, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

export interface MedicationDetailHeaderProps {
  name: string;
  dose: string;
  active: boolean;
  endsOn?: string | null;
  /**
   * v1.6.0 — the single "Bearbeiten" button opens the unified editor
   * (mode="edit"). The two-option dropdown the v1.5.6 header carried
   * collapsed to one direct button so editing is a single tap.
   */
  onEditPlan: () => void;
  /**
   * v1.7.0 — the History (clock) button routes directly to the full
   * intake-history view. A `() => void` so the page owns the
   * `router.push`; an icon-only button (not an anchor) since it carries
   * an `aria-label`.
   */
  onOpenHistory: () => void;
  /**
   * v1.7.0 — the sliders button opens the `<AdvancedSettingsSheet>`
   * (Data / Reminders / Lifecycle / Danger zone). Kept as a discreet
   * secondary affordance beside the primary edit button.
   */
  onOpenAdvanced: () => void;
}

type Status = "active" | "paused" | "ended";

function resolveStatus(active: boolean, endsOn?: string | null): Status {
  // `endsOn` set + in the past = the medication is archived. The
  // server flips `active=false` in that case but a paused medication
  // also reads false; distinguish here so the pill carries the right
  // label.
  if (endsOn) {
    const end = new Date(endsOn);
    if (!Number.isNaN(end.getTime()) && end.getTime() <= Date.now()) {
      return "ended";
    }
  }
  return active ? "active" : "paused";
}

export function MedicationDetailHeader({
  name,
  dose,
  active,
  endsOn,
  onEditPlan,
  onOpenHistory,
  onOpenAdvanced,
}: MedicationDetailHeaderProps) {
  const { t } = useTranslations();
  const status = resolveStatus(active, endsOn);

  const statusLabel =
    status === "active"
      ? t("medications.detail.status.active")
      : status === "paused"
        ? t("medications.detail.status.paused")
        : t("medications.detail.status.ended");

  const dotClass =
    status === "active"
      ? "bg-[hsl(var(--success))]"
      : status === "paused"
        ? "bg-[hsl(var(--warning))]"
        : "bg-muted-foreground";

  return (
    <div
      className="flex items-start justify-between gap-3"
      data-slot="medication-detail-header"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
        <p className="text-muted-foreground text-sm">{dose}</p>
        <div
          className="text-muted-foreground flex items-center gap-2 text-xs"
          data-slot="medication-detail-status-row"
        >
          <Badge variant="secondary" className="gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${dotClass}`}
            />
            {statusLabel}
          </Badge>
        </div>
      </div>
      {/* v1.7.0 — three-button row: Edit (primary, labelled) →
          History (ghost icon, direct to /history) → Advanced (ghost
          icon, sliders). DOM order primary → read → config. All carry a
          44px touch target on mobile. */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={onEditPlan}
          data-slot="medication-detail-edit-button"
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
          <span>{t("common.edit")}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          onClick={onOpenHistory}
          aria-label={t("medications.detail.header.historyLabel")}
          data-slot="medication-detail-history-button"
        >
          <History aria-hidden="true" className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          onClick={onOpenAdvanced}
          aria-label={t("medications.detail.header.advancedLabel")}
          data-slot="medication-detail-advanced-button"
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
