"use client";

/**
 * The seizure diary page (#1368).
 *
 * Top to bottom, in the order a carer needs it: the quick log with its timer,
 * the figures for the last 90 days (all derived on the server), the recorded
 * seizures, the person's seizure types with their plans, and the cluster rule.
 * The page records and summarises what was observed; the header says so, and
 * nothing on it diagnoses, scores a risk or says it is safe to wait.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BrainCircuit,
  ChevronRight,
  ListChecks,
  Plus,
  Settings2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAction } from "@/components/ui/inline-action";
import { ListCapNotice } from "@/components/ui/list-cap-notice";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import { TileHeader } from "@/components/insights/tile-header";
import { useAuth } from "@/hooks/use-auth";
import { useDeepLinkedRecord } from "@/hooks/use-deep-linked-record";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { SeizureEventDTO, SeizureTypeDTO } from "@/lib/seizures/shared";

import { QuickLogCard } from "./quick-log-card";
import { SeizureSheet } from "./seizure-sheet";
import { SeizureSummary } from "./seizure-summary";
import { SeizureTypeSheet } from "./seizure-type-sheet";
import { ClusterRuleCard } from "./cluster-rule-card";
import { formatClock, ilaeLine, typeName } from "./seizure-format";
import { useSeizureDiary } from "./use-seizures";

export function SeizuresView() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // Recording a seizure and a rescue dose is a WRITE; correcting, removing,
  // setting up types and the rule are MANAGE (the routes say so).
  const canLog = canWriteDomain("illness");
  const canManage = canManageDomain("illness");
  const recordId = user?.accountAccess?.active?.accountId ?? user?.id ?? null;
  const diary = useSeizureDiary();
  const data = diary.data;
  const types = useMemo(() => data?.types ?? [], [data]);
  const typeById = useMemo(
    () => new Map(types.map((ty) => [ty.id, ty])),
    [types],
  );

  const [sheet, setSheet] = useState<{
    session: number;
    event: SeizureEventDTO | null;
  } | null>(null);
  const [typeSheet, setTypeSheet] = useState<{
    session: number;
    type: SeizureTypeDTO | null;
  } | null>(null);
  const openEvent = (event: SeizureEventDTO | null) =>
    setSheet((s) => ({ session: (s?.session ?? 0) + 1, event }));
  const openType = (type: SeizureTypeDTO | null) =>
    setTypeSheet((s) => ({ session: (s?.session ?? 0) + 1, type }));

  const events = data?.events ?? [];
  // `/seizures?event=<id>`, where the cluster push leads: scroll to the
  // seizure and open it for a reader who may write; anyone else only scrolls.
  useDeepLinkedRecord({
    param: "event",
    records: data?.events,
    anchorAttribute: "data-seizure-id",
    open: canLog ? openEvent : undefined,
  });

  const clusterEventIds = useMemo(
    () => new Set(data?.summary.clusters.flatMap((c) => c.eventIds) ?? []),
    [data],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("seizures.title")}
        description={t("seizures.subtitle")}
      />
      <p className="text-foreground text-sm">{t("seizures.safety.header")}</p>

      {diary.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : diary.isError ? (
        <QueryErrorCard
          error={diary.error}
          title={t("seizures.loadError")}
          onRetry={() => void diary.refetch()}
        />
      ) : data && recordId ? (
        <>
          <QuickLogCard
            key={recordId}
            recordId={recordId}
            types={types}
            lastTypeId={events[0]?.typeProfileId ?? null}
            canLog={canLog}
            onRecorded={(event) => openEvent(event)}
            onLogPast={() => openEvent(null)}
          />

          <SeizureSummary diary={data} />

          <SeizureList
            events={events}
            typeById={typeById}
            truncated={data.truncated}
            clusterEventIds={clusterEventIds}
            onOpen={openEvent}
          />

          <SeizureTypeList
            types={types}
            canManage={canManage}
            onOpen={openType}
          />

          <ClusterRuleCard
            icon={Settings2}
            rule={data.settings.rule}
            niceRule={data.settings.niceRule}
            canManage={canManage}
          />

          <p className="text-muted-foreground text-xs">
            {t("seizures.safety.notifications")}
          </p>
        </>
      ) : null}

      {sheet ? (
        <SeizureSheet
          key={sheet.session}
          open
          onClose={() => setSheet(null)}
          event={sheet.event}
          types={types}
          defaultTypeId={events[0]?.typeProfileId ?? null}
          canManage={canManage}
        />
      ) : null}
      {typeSheet ? (
        <SeizureTypeSheet
          key={typeSheet.session}
          open
          onClose={() => setTypeSheet(null)}
          type={typeSheet.type}
        />
      ) : null}
    </div>
  );
}

/** The recorded seizures, newest first; twenty until asked for all. */
function SeizureList({
  events,
  typeById,
  truncated,
  clusterEventIds,
  onOpen,
}: {
  events: SeizureEventDTO[];
  typeById: ReadonlyMap<string, SeizureTypeDTO>;
  truncated: boolean;
  /** Seizures that belong to a cluster episode under the record's rule. */
  clusterEventIds: ReadonlySet<string>;
  onOpen: (event: SeizureEventDTO) => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // A linked seizure past the first twenty must be on the page to scroll to.
  const linked = useSearchParams()?.get("event") ?? null;
  const [showAll, setShowAll] = useState(
    () => linked !== null && events.findIndex((e) => e.id === linked) >= 20,
  );
  const listed = showAll ? events : events.slice(0, 20);
  const openEvent = onOpen;
  return (
    <Card>
      <CardHeader>
        <TileHeader icon={ListChecks} title={t("seizures.list.title")} />
      </CardHeader>
      <CardContent className="space-y-3">
        {events.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("seizures.list.empty")}
          />
        ) : (
          <ul className="divide-border divide-y">
            {listed.map((event) => {
              const type = event.typeProfileId
                ? typeById.get(event.typeProfileId)
                : undefined;
              return (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => openEvent(event)}
                    data-seizure-id={event.id}
                    className="hover:bg-accent focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="flex w-full flex-wrap items-center gap-2">
                        <span className="text-foreground text-sm font-medium">
                          {typeName(type, t)}
                        </span>
                        {event.count > 1 ? (
                          <TagChip>×{event.count}</TagChip>
                        ) : null}
                        {event.certainty === "SUSPECTED" ? (
                          <TagChip>{t("seizures.certainty.SUSPECTED")}</TagChip>
                        ) : null}
                        {event.rescueDoses.length > 0 ? (
                          <TagChip>{t("seizures.list.rescue")}</TagChip>
                        ) : null}
                        {clusterEventIds.has(event.id) ? (
                          <TagChip data-slot="seizure-cluster-chip">
                            {t("seizures.list.cluster")}
                          </TagChip>
                        ) : null}
                        <span className="text-foreground ml-auto text-sm tabular-nums">
                          {event.durationSec === null
                            ? "—"
                            : `${event.durationSource === "ESTIMATED" ? "~" : ""}${formatClock(event.durationSec)}`}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {fmt.dateTime(event.onsetAt)}
                        {event.sleepState !== "UNKNOWN"
                          ? ` · ${t(`seizures.sleepState.${event.sleepState}`)}`
                          : ""}
                        {event.loggedBy === "delegate"
                          ? ` · ${
                              event.loggedByViewer
                                ? t("seizures.list.loggedByYou")
                                : event.loggedByName
                                  ? t("seizures.list.loggedByName", {
                                      name: event.loggedByName,
                                    })
                                  : t("seizures.list.loggedByDelegate")
                            }`
                          : ""}
                      </span>
                    </span>
                    <ChevronRight
                      className="text-muted-foreground size-4 shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {events.length > listed.length ? (
          <InlineAction
            tone="primary"
            size="sm"
            onClick={() => setShowAll(true)}
          >
            {t("seizures.list.showAll", { count: events.length })}
          </InlineAction>
        ) : null}
        <ListCapNotice
          cap={{ truncated, limit: events.length }}
          message={t("seizures.list.truncated")}
        />
      </CardContent>
    </Card>
  );
}

/** The person's seizure types with their classification and rescue plan. */
function SeizureTypeList({
  types,
  canManage,
  onOpen,
}: {
  types: SeizureTypeDTO[];
  canManage: boolean;
  onOpen: (type: SeizureTypeDTO | null) => void;
}) {
  const { t } = useTranslations();
  const openType = onOpen;
  return (
    <Card>
      <CardHeader>
        <TileHeader
          icon={BrainCircuit}
          title={t("seizures.types.title")}
          right={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
                onClick={() => openType(null)}
                data-slot="seizure-type-add"
              >
                <Plus className="size-4" />
                {t("common.add")}
              </Button>
            ) : null
          }
        />
      </CardHeader>
      <CardContent>
        {types.length === 0 ? (
          <EmptyState
            icon={<BrainCircuit className="size-6" />}
            title={t("seizures.types.emptyTitle")}
            description={t("seizures.types.emptyDescription")}
          />
        ) : (
          <ul className="divide-border divide-y">
            {types.map((ty) => (
              <li key={ty.id}>
                <button
                  type="button"
                  disabled={!canManage}
                  onClick={() => openType(ty)}
                  className="hover:bg-accent focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none disabled:hover:bg-transparent"
                >
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <span className="flex w-full items-center gap-2">
                      <span className="text-foreground text-sm font-medium">
                        {typeName(ty, t)}
                      </span>
                      {ty.archived ? (
                        <TagChip>{t("seizures.types.archived")}</TagChip>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {ilaeLine(ty.ilaeType, t)}
                    </span>
                    {ty.rescueMedicationName ? (
                      <span className="text-muted-foreground text-xs">
                        {t("seizures.types.rescueLine", {
                          name: ty.rescueMedicationName,
                        })}
                      </span>
                    ) : null}
                  </span>
                  {canManage ? (
                    <ChevronRight
                      className="text-muted-foreground size-4 shrink-0"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
