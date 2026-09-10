"use client";

/**
 * v1.38.0 — the immunization log surface.
 *
 * A calm, retrospective transcription of a lifetime Impfpass. The list groups
 * doses by their component antigen and shows where each series stands, with the
 * numbers resolved server-side (`src/lib/vaccinations/series.ts`) so this
 * client never re-derives "N von M". Neutral cards, status through a discreet
 * badge only — no red card, no overdue tint. It reproduces the record; it does
 * not adjudicate what is due.
 */
import { useState } from "react";
import { Plus, Syringe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";

import { VaccinationList } from "./vaccination-list";
import { VaccinationSheet } from "./vaccination-sheet";
import { BoosterMintPrompt, boosterOfferFor } from "./booster-mint-prompt";
import { useVaccinations, type Vaccination } from "./use-vaccinations";

export function VaccinationsView() {
  const { t } = useTranslations();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // `POST /api/vaccinations` answers at WRITE; the edit, the delete and the
  // restore behind it are all MANAGE. The page is presentable to every
  // `profile`-scoped grant, so without this a READ delegate was shown add,
  // edit and delete, and every one of them was refused by a server that was
  // right to refuse. Same split, same domain, same shape as the address book
  // next door.
  const canAddDose = canWriteDomain("profile");
  const canManageProfile = canManageDomain("profile");
  // Planning the booster mints a `MeasurementReminder`, which lives in the
  // measurements section rather than this one. A grant that opened only the
  // health background is refused there, so the offer is not made.
  const canPlanBooster = canWriteDomain("measurements");
  const { data, isLoading, isError, refetch } = useVaccinations();
  const records = data?.vaccinations ?? [];

  // One sheet for create and edit. Bumped `session` remounts it so a second
  // open never shows the first's values.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Vaccination | null>(null);
  const [session, setSession] = useState(0);
  // The just-created dose whose catalogue entry carries a booster interval;
  // drives the one-time mint offer, cleared on confirm or decline.
  const [boosterFor, setBoosterFor] = useState<Vaccination | null>(null);

  const openCreate = () => {
    setEditing(null);
    setSession((n) => n + 1);
    setSheetOpen(true);
  };
  const openEdit = (record: Vaccination) => {
    setEditing(record);
    setSession((n) => n + 1);
    setSheetOpen(true);
  };

  const addButton = canAddDose ? (
    <Button
      className="min-h-11 sm:min-h-9"
      data-slot="vaccination-add"
      onClick={openCreate}
    >
      <Plus className="size-4" />
      {t("common.add")}
    </Button>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span data-tour-id="vaccinations-hero">
            {t("vaccinations.title")}
          </span>
        }
        description={t("vaccinations.subtitle")}
        actions={addButton}
      />

      <VaccinationSheet
        key={session}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        vaccination={editing}
        onCreated={(created) => {
          // Offer the booster only when the catalogue entry carries an
          // interval; a free-text or one-off dose never prompts.
          if (canPlanBooster && boosterOfferFor(created))
            setBoosterFor(created);
        }}
      />

      <BoosterMintPrompt
        key={boosterFor?.id ?? "none"}
        record={boosterFor}
        onClose={() => setBoosterFor(null)}
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        // A read failure is not an empty Impfpass — surface the error + Retry so
        // an outage never reads as "nothing logged yet".
        <QueryErrorCard
          title={t("vaccinations.listLoadError")}
          onRetry={() => void refetch()}
        />
      ) : records.length > 0 ? (
        <VaccinationList
          records={records}
          onEdit={canManageProfile ? openEdit : undefined}
        />
      ) : (
        <EmptyState
          icon={<Syringe className="size-6" />}
          title={t("vaccinations.empty.title")}
          description={t("vaccinations.empty.description")}
          action={
            canAddDose ? (
              <Button
                className="min-h-11 sm:min-h-9"
                data-slot="vaccination-add-empty"
                onClick={openCreate}
              >
                <Plus className="size-4" />
                {t("common.add")}
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}
