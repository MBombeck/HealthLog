"use client";

/**
 * v1.18.2 — the illness / condition-journal surface.
 *
 * A calm, retrospective journal. The episode history reads as a grid of
 * medication-styled cards: a header (label link + neutral type / status
 * badges + an overflow kebab) and a single bottom-pinned "Log a day"
 * primary action — one clear action per card, the most-common one promoted.
 * The list is split into "Active" and "Resolved" groups (active first), and
 * flares nest under their parent condition so the parent relationship the
 * form captures is visible. The cross-episode retrospective summary sits
 * directly under the header so a long list never buries it. Each card
 * navigates to the episode-detail surface (`/illness/[id]`) where the
 * per-day timeline and correlation card live. Retrospective-only copy — a
 * journal, not a medical device, and it does not diagnose.
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Plus, Stethoscope, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";

import { LogDaySheet } from "./log-day-sheet";
import { NewEpisodeSheet } from "./new-episode-sheet";
import { EpisodeMenu } from "./episode-menu";
import { IllnessInsightsCard } from "./illness-insights-card";
import { useIllnessEpisodes, useResolveEpisode } from "./use-illness";
import type { IllnessEpisodeDTO } from "./types";

/** Today as a YYYY-MM-DD string in the viewer's local calendar. */
function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface EpisodeCardProps {
  episode: IllnessEpisodeDTO;
  /** Flares that hang off this episode (rendered nested), already filtered. */
  flares?: IllnessEpisodeDTO[];
  onLogDay: (id: string) => void;
  onEdit: (episode: IllnessEpisodeDTO) => void;
  onResolve: (id: string) => void;
  resolving: boolean;
  view: "cards" | "list";
}

function EpisodeCard({
  episode,
  flares,
  onLogDay,
  onEdit,
  onResolve,
  resolving,
  view,
}: EpisodeCardProps) {
  const { t } = useTranslations();
  const { canManageDomain } = useRecordCapabilities();
  const canManageIllness = canManageDomain("illness");
  const fmt = useFormatters();
  const active = episode.resolvedAt === null;
  const isChronic = episode.lifecycle === "CHRONIC_ONGOING";
  const flareCount = flares?.length ?? 0;

  // v1.18.6 (MOD-03) — compact list row: a single divided line per episode
  // (label + status chips + onset; tap navigates to the detail surface).
  if (view === "list") {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0 space-y-0.5">
            <Link
              href={`/illness/${episode.id}`}
              className="block truncate text-sm font-medium hover:underline focus-visible:underline"
            >
              {episode.label}
            </Link>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
              <span className="text-muted-foreground">
                {fmt.dateShortSmart(new Date(episode.onsetAt))}
              </span>
            </div>
          </div>
          {canManageIllness && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => onLogDay(episode.id)}
              >
                {t("illness.logDay")}
              </Button>
              <EpisodeMenu
                episode={episode}
                onEdit={() => onEdit(episode)}
                onResolve={
                  active && !isChronic ? () => onResolve(episode.id) : undefined
                }
                resolving={resolving}
              />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full gap-3 md:gap-3">
      <CardHeader>
        <CardTitle className="min-w-0">
          <Link
            href={`/illness/${episode.id}`}
            className="hover:underline focus-visible:underline"
          >
            <span className="block truncate">{episode.label}</span>
          </Link>
        </CardTitle>
        {canManageIllness && (
          <CardAction>
            <EpisodeMenu
              episode={episode}
              onEdit={() => onEdit(episode)}
              onResolve={
                active && !isChronic ? () => onResolve(episode.id) : undefined
              }
              resolving={resolving}
            />
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="flex h-full flex-col space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(`illness.type.${episode.type}`)}</Badge>
          <Badge variant="outline">
            {active
              ? isChronic
                ? t("illness.status.ongoing")
                : t("illness.status.active")
              : t("illness.status.recovered")}
          </Badge>
        </div>

        <p className="text-muted-foreground text-xs">
          {t("illness.onsetOn", {
            date: fmt.dateShortSmart(new Date(episode.onsetAt)),
          })}
          {episode.resolvedAt
            ? ` · ${t("illness.recoveredOn", {
                date: fmt.dateShortSmart(new Date(episode.resolvedAt)),
              })}`
            : ""}
        </p>

        {flareCount > 0 ? (
          <div className="space-y-1 border-l-2 pl-3">
            <p className="text-muted-foreground text-xs font-medium">
              {flareCount === 1
                ? t("illness.flares.countOne")
                : t("illness.flares.countOther", { count: flareCount })}
            </p>
            <ul className="space-y-1">
              {flares!.map((flare) => (
                <li key={flare.id}>
                  <Link
                    href={`/illness/${flare.id}`}
                    className="text-foreground/80 hover:text-foreground flex items-center gap-2 text-xs hover:underline"
                  >
                    <span className="truncate">{flare.label}</span>
                    <span className="text-muted-foreground shrink-0">
                      {fmt.dateShortSmart(new Date(flare.onsetAt))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Bottom-pinned single primary action — the daily-use "log a day"
            flow, promoted from a busy inline cluster. The card navigates to
            the detail surface on its title link; this is the one explicit
            button. */}
        {canManageIllness && (
          <div className="mt-auto pt-0">
            <Button
              className="min-h-11 w-full sm:min-h-9"
              onClick={() => onLogDay(episode.id)}
            >
              {t("illness.logDay")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EpisodeGroup({
  title,
  parents,
  childrenByParent,
  onLogDay,
  onEdit,
  onResolve,
  resolving,
  view,
  collapsible = false,
}: {
  title: string;
  parents: IllnessEpisodeDTO[];
  childrenByParent: Map<string, IllnessEpisodeDTO[]>;
  onLogDay: (id: string) => void;
  onEdit: (episode: IllnessEpisodeDTO) => void;
  onResolve: (id: string) => void;
  resolving: boolean;
  view: "cards" | "list";
  /**
   * v1.18.6 (MOD-05) — the resolved group collapses by default behind a
   * disclosure trigger so a long recovered history never pushes the active
   * conditions below the fold.
   */
  collapsible?: boolean;
}) {
  // Hooks must run unconditionally; bail on the empty render afterwards.
  const [open, setOpen] = useState(false);
  const gridId = useId();
  if (parents.length === 0) return null;

  const grid = (
    <div
      id={gridId}
      className={cn(
        view === "list" ? "space-y-2" : "grid gap-4 sm:grid-cols-2",
      )}
    >
      {parents.map((episode) => (
        <EpisodeCard
          key={episode.id}
          episode={episode}
          flares={childrenByParent.get(episode.id)}
          resolving={resolving}
          onLogDay={onLogDay}
          onEdit={onEdit}
          onResolve={onResolve}
          view={view}
        />
      ))}
    </div>
  );

  if (collapsible) {
    return (
      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={gridId}
          className="text-muted-foreground hover:text-foreground -mx-1 flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium tracking-wide uppercase transition-colors"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              open ? "rotate-0" : "-rotate-90",
            )}
            aria-hidden="true"
          />
          {title}
          <span className="normal-case">({parents.length})</span>
        </button>
        {open ? grid : null}
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {title}
      </h2>
      {grid}
    </section>
  );
}

export function IllnessView() {
  const { t } = useTranslations();
  // v1.36.x — opening an illness entry is an admitted delegated write. Logging
  // a day against one, editing it, resolving it and deleting it are not, so a
  // delegate can start the record of an illness and nothing more.
  const { canWriteDomain, inSharedRecord } = useRecordCapabilities();
  const canAddEpisode = canWriteDomain("illness");
  const {
    data: episodes,
    isLoading,
    isError,
    refetch,
  } = useIllnessEpisodes(true);
  const resolve = useResolveEpisode();
  const { prefs } = useModuleListPrefs("illness");

  const today = todayLocal();
  const [newOpen, setNewOpen] = useState(false);
  const [editEpisode, setEditEpisode] = useState<IllnessEpisodeDTO | null>(
    null,
  );
  const [logEpisodeId, setLogEpisodeId] = useState<string | null>(null);

  const logEpisode = episodes?.find((e) => e.id === logEpisodeId) ?? null;

  /**
   * Group the flat list into active / resolved, nesting flares under their
   * parent condition. A flare nests only when its parent lives in the same
   * status group (so an active flare under a resolved parent still surfaces as
   * its own active card rather than vanishing); otherwise it renders as a
   * standalone parent card in its own group.
   */
  const grouped = useMemo(() => {
    const list = episodes ?? [];
    const byId = new Map(list.map((e) => [e.id, e]));
    const isActive = (e: IllnessEpisodeDTO) => e.resolvedAt === null;

    const activeParents: IllnessEpisodeDTO[] = [];
    const resolvedParents: IllnessEpisodeDTO[] = [];
    const childrenByParent = new Map<string, IllnessEpisodeDTO[]>();

    for (const e of list) {
      const parent = e.parentConditionId
        ? byId.get(e.parentConditionId)
        : undefined;
      const nestsUnderParent =
        parent !== undefined && isActive(parent) === isActive(e);

      if (nestsUnderParent) {
        const bucket = childrenByParent.get(parent.id) ?? [];
        bucket.push(e);
        childrenByParent.set(parent.id, bucket);
      } else if (isActive(e)) {
        activeParents.push(e);
      } else {
        resolvedParents.push(e);
      }
    }

    return {
      // v1.18.6 (MOD-03) — honour the user's persisted manual order within
      // each status group (ids absent from the order sort after the block).
      activeParents: applyOrder(activeParents, prefs.order, (e) => e.id),
      resolvedParents: applyOrder(resolvedParents, prefs.order, (e) => e.id),
      childrenByParent,
    };
  }, [episodes, prefs.order]);

  const hasEpisodes = (episodes?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span data-tour-id="illness-hero">{t("illness.title")}</span>}
        description={t("illness.subtitle")}
        actions={
          <>
            {/* v1.18.6 (MOD-01) — wrench left of the primary Add, linking to the
                Illness settings page (view + reorder). `/settings` is the
                caller's, not the record's, so no grant reaches it. */}
            {!inSharedRecord && (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
              >
                <Link
                  href="/settings/layout/illness"
                  aria-label={t("illness.customize")}
                  title={t("illness.customize")}
                >
                  <Wrench className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {/* v1.18.6 (MOD-02) — the add button reads "hinzufügen" like every
                other module, not the bespoke "neue Episode". */}
            {canAddEpisode && (
              <Button
                onClick={() => setNewOpen(true)}
                className="min-h-11 sm:min-h-9"
              >
                <Plus className="h-4 w-4" />
                {t("common.add")}
              </Button>
            )}
          </>
        }
      />

      {/* v1.18.6 (DISC-01) — the per-page medical disclaimer line is removed;
          the one-time acknowledgment now lives at onboarding and the legal
          text stays reachable on the public privacy page. */}

      {isLoading ? (
        <div className={cn("grid gap-4 sm:grid-cols-2")}>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : isError ? (
        // A read failure is NOT an empty journal — surface the error + Retry so
        // an outage never reads as "no episodes yet".
        <QueryErrorCard
          title={t("illness.listLoadError")}
          onRetry={() => void refetch()}
        />
      ) : hasEpisodes ? (
        <>
          {/* Retrospective summary sits above the list so a long history
              never buries it. */}
          <IllnessInsightsCard />

          <EpisodeGroup
            title={t("illness.section.active")}
            parents={grouped.activeParents}
            childrenByParent={grouped.childrenByParent}
            resolving={resolve.isPending}
            view={prefs.view}
            onLogDay={(id) => setLogEpisodeId(id)}
            onEdit={(e) => setEditEpisode(e)}
            onResolve={(id) => resolve.mutate(id)}
          />
          <EpisodeGroup
            title={t("illness.section.resolved")}
            parents={grouped.resolvedParents}
            childrenByParent={grouped.childrenByParent}
            resolving={resolve.isPending}
            view={prefs.view}
            collapsible
            onLogDay={(id) => setLogEpisodeId(id)}
            onEdit={(e) => setEditEpisode(e)}
            onResolve={(id) => resolve.mutate(id)}
          />
        </>
      ) : (
        <EmptyState
          icon={<Stethoscope className="size-6" />}
          title={t("illness.empty.title")}
          description={t("illness.empty.body")}
          ctaSize="lg"
          action={
            canAddEpisode ? (
              <Button onClick={() => setNewOpen(true)}>
                <Plus className="h-4 w-4" />
                {t("illness.newEpisode")}
              </Button>
            ) : undefined
          }
        />
      )}

      <NewEpisodeSheet open={newOpen} onOpenChange={setNewOpen} today={today} />
      <NewEpisodeSheet
        open={editEpisode !== null}
        onOpenChange={(open) => {
          if (!open) setEditEpisode(null);
        }}
        today={today}
        editEpisode={editEpisode ?? undefined}
      />
      {logEpisodeId ? (
        <LogDaySheet
          open={logEpisodeId !== null}
          onOpenChange={(open) => {
            if (!open) setLogEpisodeId(null);
          }}
          episodeId={logEpisodeId}
          date={today}
          onsetDate={logEpisode?.onsetAt.slice(0, 10)}
        />
      ) : null}
    </div>
  );
}
