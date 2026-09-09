"use client";

/**
 * "Termine dazu" — the visits filed against one condition episode.
 *
 * **From the episode side only, and that is a decision rather than an
 * omission.** An episode spans weeks and a visit is a point, so matching from
 * the VISIT side would produce false positives at a rate that teaches a person
 * to ignore every suggestion in the product. Here the person already has the
 * condition in front of them and is the one who knows; the card offers an
 * action instead of a guess.
 *
 * Modelled on the episode's documents card, which does exactly this for the
 * vault. Renders nothing when the illness module is off — a gated surface never
 * leaks, and an episode page is unreachable in that state anyway.
 */
import { CalendarClock, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { EncounterSheet } from "@/components/encounters/encounter-sheet";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useEncounters } from "@/hooks/use-encounters";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";

export function EpisodeVisitsCard({ episodeId }: { episodeId: string }) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { user } = useAuth();
  const { canWriteDomain } = useRecordCapabilities();
  // The pre-linked visit is a `POST /api/encounters`, which answers at WRITE.
  const canAddVisit = canWriteDomain("profile");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [session, setSession] = useState(0);

  const moduleEnabled = user?.modules?.illness === true;
  // The filter runs in SQL: the two arms of the response are separately
  // bounded, so narrowing here would page wrongly on a long history.
  const list = useEncounters(moduleEnabled, { episodeId });

  if (!moduleEnabled) return null;

  if (list.isError) {
    return (
      <QueryErrorCard
        title={t("encounters.loadError")}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const visits = [...(list.data?.upcoming ?? []), ...(list.data?.past ?? [])];

  return (
    <>
      <Card data-slot="episode-visits-card">
        <CardContent className="space-y-4">
          <TileHeader
            icon={CalendarClock}
            title={t("encounters.episodeCard.title")}
            right={
              visits.length > 0 ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {visits.length}
                </span>
              ) : undefined
            }
          />

          {list.isPending ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }, (_, index) => (
                <Skeleton key={index} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          ) : visits.length === 0 ? (
            // A quiet one-line absence, not a teaching empty state: the person
            // came here about the condition, not to be taught about visits.
            <p className="text-muted-foreground text-sm">
              {t("encounters.episodeCard.emptyLine")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visits.map((visit) => (
                <li key={visit.id}>
                  <ListRow asChild>
                    <Link
                      href="/checkups"
                      data-encounter-id={visit.id}
                      className="hover:bg-muted/50 focus-visible:ring-ring/50 flex items-center gap-3 focus-visible:ring-[3px] focus-visible:outline-none"
                    >
                      <CalendarClock
                        className="text-foreground size-5 shrink-0"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {visit.practitioner?.name ??
                          encounterKindText(t, visit.kind as EncounterKind)}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {format.date(visit.occurredAt)}
                      </span>
                    </Link>
                  </ListRow>
                </li>
              ))}
            </ul>
          )}

          {canAddVisit ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                data-slot="episode-visits-add"
                onClick={() => {
                  setSheetOpen(true);
                  setSession((n) => n + 1);
                }}
              >
                <Plus className="size-4" aria-hidden />
                {t("encounters.episodeCard.add")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {canAddVisit ? (
        <EncounterSheet
          key={session}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          encounter={null}
          // Pre-linked, so the person never has to find this condition again
          // in a picker they already navigated away from.
          episodeId={episodeId}
        />
      ) : null}
    </>
  );
}
