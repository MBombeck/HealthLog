"use client";

/**
 * v1.7.2 — shared medication-card overflow menu.
 *
 * Both the generic `<MedicationCard>` and the `<Glp1MedicationCard>`
 * collapsed their former four header icon-buttons (open / edit / history
 * / advanced) into a single overflow kebab so the card header carries one
 * affordance instead of a cluster. The card body itself navigates to the
 * detail page (the former chevron target); this menu owns the edit and
 * history actions. v1.15.20 retires the "Advanced settings" item — the
 * detail page's Erweitert tab is reachable through the card body.
 * v1.16.1 — Edit navigates to the detail page's Übersicht tab (the same
 * target as the name tap); the structural wizard lives under the detail
 * page's Erweitert → Lebenszyklus row.
 *
 * Side-effect logging lives on the detail page's `<SideEffectsSection>`, so
 * the two card variants carry the same menu (one kebab, identical items).
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

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { ExternalLink, History, MoreVertical, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { buildLeafletSearch } from "@/lib/medications/leaflet-registries";

export interface MedicationCardMenuProps {
  onEdit: () => void;
  onOpenHistory: () => void;
  /**
   * #1430 — the medication the leaflet items open for: the saved leaflet
   * link, and the registry search of the person's chosen registry, built by
   * the same pure function the detail read uses. Both open in a new tab.
   */
  leaflet?: { name: string; dose: string; leafletUrl?: string | null };
}

export function MedicationCardMenu({
  onEdit,
  onOpenHistory,
  leaflet,
}: MedicationCardMenuProps) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // Editing the medication and opening its history editor are owner work, not
  // delegated writes. Without either, the trigger goes too rather than opening
  // onto an empty menu. The card itself is untouched: no wash, no badge, no
  // colour change.
  const { canManageDomain } = useRecordCapabilities();
  if (!canManageDomain("medications")) return null;
  const search = leaflet
    ? buildLeafletSearch(user?.medicineRegistry, leaflet)
    : null;

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
        {leaflet?.leafletUrl && (
          <DropdownMenuItem asChild>
            <a
              href={leaflet.leafletUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-slot="medication-card-menu-leaflet-saved"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("medications.leaflet.saved")}
            </a>
          </DropdownMenuItem>
        )}
        {search && (
          <DropdownMenuItem asChild>
            <a
              href={search.url}
              target="_blank"
              rel="noopener noreferrer"
              data-slot="medication-card-menu-leaflet-find"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("medications.leaflet.find")}
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
