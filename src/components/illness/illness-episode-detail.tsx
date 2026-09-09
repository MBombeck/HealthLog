"use client";

/**
 * v1.18.1 — per-episode detail surface (`/illness/[id]`), mirroring
 * `/labs/[biomarkerId]`. Carries the heading + neutral status, a "log a day"
 * entry, the stored note, an Edit affordance (the same capture sheet
 * pre-filled), and the retrospective correlation card (recovery-gap /
 * red-flag / pre-onset / nadir). Calm + retrospective — no prediction UI, no
 * alarming colour.
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useState } from "react";

import { EpisodeVisitsCard } from "@/components/illness/episode-visits-card";
import { EpisodeDocumentsCard } from "@/components/documents/episode-documents-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

import { IllnessCorrelationCard } from "./illness-correlation-card";
import { IllnessDayTimeline } from "./illness-day-timeline";
import { LogDaySheet } from "./log-day-sheet";
import { NewEpisodeSheet } from "./new-episode-sheet";
import { EpisodeMenu } from "./episode-menu";
import { useIllnessEpisode, useResolveEpisode } from "./use-illness";

/** Today as YYYY-MM-DD in the viewer's local calendar. */
function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function IllnessEpisodeDetail({ episodeId }: { episodeId: string }) {
  const { t } = useTranslations();
  // v1.36.x — logging a day, editing and resolving an episode are the
  // owner's; a delegate reads the episode.
  const { canManageDomain } = useRecordCapabilities();
  const canManageIllness = canManageDomain("illness");
  const fmt = useFormatters();
  const {
    data: episode,
    isLoading,
    isError,
    refetch,
  } = useIllnessEpisode(episodeId);
  const resolve = useResolveEpisode();

  const [logOpen, setLogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const today = todayLocal();

  if (isError) {
    return (
      <QueryErrorCard
        title={t("illness.loadError")}
        onRetry={() => void refetch()}
      />
    );
  }

  const active = episode ? episode.resolvedAt === null : false;
  const isChronic = episode?.lifecycle === "CHRONIC_ONGOING";

  return (
    <div className="space-y-6">
      <PageHeader
        title={episode?.label ?? <Skeleton className="h-7 w-40" />}
        description={
          episode ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                {t(`illness.type.${episode.type}`)}
              </Badge>
              <Badge variant="outline">
                {active
                  ? isChronic
                    ? t("illness.status.ongoing")
                    : t("illness.status.active")
                  : t("illness.status.recovered")}
              </Badge>
              <span className="text-muted-foreground text-xs">
                {t("illness.onsetOn", {
                  date: fmt.dateShortSmart(new Date(episode.onsetAt)),
                })}
                {episode.resolvedAt
                  ? ` · ${t("illness.recoveredOn", {
                      date: fmt.dateShortSmart(new Date(episode.resolvedAt)),
                    })}`
                  : ""}
              </span>
            </span>
          ) : undefined
        }
        actions={
          canManageIllness ? (
            <>
              <Button
                onClick={() => setLogOpen(true)}
                className="min-h-11 sm:min-h-9"
              >
                {t("illness.logDay")}
              </Button>
              {episode ? (
                <EpisodeMenu
                  episode={episode}
                  onEdit={() => setEditOpen(true)}
                  onResolve={
                    active && !isChronic
                      ? () => resolve.mutate(episode.id)
                      : undefined
                  }
                  resolving={resolve.isPending}
                />
              ) : null}
            </>
          ) : undefined
        }
      />

      {episode?.note ? (
        <Card>
          <CardContent>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("illness.detail.note")}
            </p>
            <p className="text-foreground mt-1 text-sm whitespace-pre-wrap">
              {episode.note}
            </p>
          </CardContent>
        </Card>
      ) : null}

      {/* The per-day timeline lives only on the detail surface — the list
          rows stay clean summaries, so navigating here reveals genuinely new
          content (today's logged symptoms / impact / fever). */}
      {episode ? (
        <IllnessDayTimeline
          episodeId={episode.id}
          onLogDay={() => setLogOpen(true)}
        />
      ) : null}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <IllnessCorrelationCard episodeId={episodeId} />
      )}

      {/* Condition ⇄ documents linking, condition side: the episode's
          linked documents plus link/upload entries into the vault. Renders
          nothing when the documents module is off for this account. */}
      {episode ? <EpisodeDocumentsCard episodeId={episode.id} /> : null}

      {/* Condition ⇄ visits linking, condition side ONLY. A visit never
          suggests an episode: an episode spans weeks and a visit is a point,
          so the reverse match would be wrong often enough to train the person
          to ignore every suggestion in the product. */}
      {episode ? <EpisodeVisitsCard episodeId={episode.id} /> : null}

      {episode ? (
        <>
          <LogDaySheet
            open={logOpen}
            onOpenChange={setLogOpen}
            episodeId={episode.id}
            date={today}
            onsetDate={episode.onsetAt.slice(0, 10)}
          />
          <NewEpisodeSheet
            open={editOpen}
            onOpenChange={setEditOpen}
            today={today}
            editEpisode={episode}
          />
        </>
      ) : null}
    </div>
  );
}
