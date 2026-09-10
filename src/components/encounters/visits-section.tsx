"use client";

/**
 * "Termine" — the visits half of the checkups page.
 *
 * Two lists rather than one, and the split is the server's: upcoming reads
 * soonest-first, past reads newest-first, and the API resolves both so the
 * ordering lives in one place. A client that split and re-sorted one array
 * would be the second place it lives.
 *
 * No new nav entry and no new route. `/checkups` already owns exactly the right
 * sentence — when do I have to do what, where — and is deliberately not module
 * gated, which is also why a visit carries no module key of its own.
 */
import { CalendarClock, ContactRound, History, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useEncounters, type Encounter } from "@/hooks/use-encounters";
import { useTranslations } from "@/lib/i18n/context";
import { EncounterSheet } from "./encounter-sheet";
import { VisitCard } from "./visit-card";

export function VisitsSection({ enabled = true }: { enabled?: boolean }) {
  const { t } = useTranslations();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // `POST /api/encounters` answers at WRITE under the profile section; the
  // edit and the delete behind the row are both MANAGE. Only the add was
  // asked, so every row stayed tappable into a sheet whose Save and Delete
  // the server refuses.
  const canAddVisit = canWriteDomain("profile");
  const canManageVisits = canManageDomain("profile");
  const list = useEncounters(enabled);

  // `null` closed, `"new"` create, a row edits it.
  const [editing, setEditing] = useState<Encounter | "new" | null>(null);
  const [session, setSession] = useState(0);
  const openSheet = (target: Encounter | "new") => {
    setEditing(target);
    setSession((n) => n + 1);
  };

  const upcoming = list.data?.upcoming ?? [];
  const past = list.data?.past ?? [];
  const empty = upcoming.length === 0 && past.length === 0;

  const addButton = canAddVisit ? (
    <Button
      type="button"
      className="min-h-11"
      data-slot="visits-add"
      onClick={() => openSheet("new")}
    >
      <Plus className="size-4" aria-hidden />
      {t("encounters.add")}
    </Button>
  ) : null;

  return (
    <section aria-labelledby="visits-section-title" className="space-y-4">
      <PageHeader
        titleId="visits-section-title"
        title={t("encounters.sectionTitle")}
        description={t("encounters.sectionDescription")}
        actions={
          <>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/checkups/practitioners">
                <ContactRound className="size-4" aria-hidden />
                {t("practitioners.linkLabel")}
              </Link>
            </Button>
            {addButton}
          </>
        }
      />

      {list.isError ? (
        <QueryErrorCard
          title={t("encounters.loadError")}
          onRetry={() => void list.refetch()}
        />
      ) : list.isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          icon={<CalendarClock className="size-6" aria-hidden />}
          title={t("encounters.emptyTitle")}
          description={t("encounters.emptyDescription")}
          action={addButton ?? undefined}
          ctaSize="lg"
        />
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 ? (
            <div className="space-y-2" data-slot="visits-upcoming">
              <SectionHeading
                icon={CalendarClock}
                title={t("encounters.upcomingHeading")}
              />
              {upcoming.map((encounter) => (
                <VisitCard
                  key={encounter.id}
                  encounter={encounter}
                  onOpen={canManageVisits ? openSheet : undefined}
                />
              ))}
            </div>
          ) : null}

          {past.length > 0 ? (
            <div className="space-y-2" data-slot="visits-past">
              <SectionHeading
                icon={History}
                title={t("encounters.pastHeading")}
              />
              {past.map((encounter) => (
                <VisitCard
                  key={encounter.id}
                  encounter={encounter}
                  onOpen={canManageVisits ? openSheet : undefined}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* `key` changes on every open, so the sheet remounts with a fresh draft
          instead of copying props into state from an effect. It stays mounted
          while closing, which is what keeps the exit animation. */}
      <EncounterSheet
        key={session}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        encounter={editing === "new" ? null : editing}
      />
    </section>
  );
}
