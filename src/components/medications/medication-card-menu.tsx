"use client";

/**
 * v1.7.2 W3 — shared medication-card overflow menu.
 *
 * Both the generic `<MedicationCard>` and the `<Glp1MedicationCard>`
 * collapsed their former four header icon-buttons (open / edit / history
 * / advanced) into a single overflow kebab so the card header carries one
 * affordance instead of a cluster. The card body itself navigates to the
 * detail page (the former chevron target); this menu owns the edit /
 * history / advanced actions.
 *
 * The optional `onLogSideEffect` slot exists for the GLP-1 card to fold a
 * "Log side effect" item into the SAME menu, but it is NOT wired on the
 * medications list page — both card variants there receive only the
 * edit / history / advanced handlers, so the item never renders. Side-
 * effect logging lives on the detail page's `<SideEffectsSection>`. When
 * the slot is left undefined the two card variants stay byte-symmetric in
 * the header (one kebab, identical items).
 *
 * The trigger is a 44px ghost icon-button (WCAG 2.5.5); every
 * `DropdownMenuItem` already carries `min-h-11` from the shadcn
 * primitive, so the menu rows meet the tap-target floor too.
 *
 * The kebab click is a non-navigating interactive element inside a
 * tappable card; the caller stops propagation on the wrapping
 * trigger so opening the menu never also fires the card's detail-page
 * navigation.
 */

import { History, MoreVertical, Pencil, SlidersHorizontal, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";

export interface MedicationCardMenuProps {
  onEdit: () => void;
  onOpenHistory: () => void;
  onOpenAdvanced: () => void;
  /** GLP-1-only: folds the side-effect quick-log into the same menu. */
  onLogSideEffect?: () => void;
}

export function MedicationCardMenu({
  onEdit,
  onOpenHistory,
  onOpenAdvanced,
  onLogSideEffect,
}: MedicationCardMenuProps) {
  const { t } = useTranslations();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11"
          aria-label={t("common.moreOptions")}
          // Keep the kebab a non-navigating control inside the
          // tappable card — opening the menu must never also fire the
          // card's detail-page navigation.
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        data-slot="medication-card-menu"
      >
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("common.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenHistory}>
          <History className="mr-2 h-4 w-4" />
          {t("medications.detail.header.historyLabel")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenAdvanced}>
          <SlidersHorizontal className="mr-2 h-4 w-4" />
          {t("medications.detail.header.advancedLabel")}
        </DropdownMenuItem>
        {onLogSideEffect && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogSideEffect}>
              <Stethoscope className="mr-2 h-4 w-4" />
              {t("medications.glp1LogSideEffect")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
