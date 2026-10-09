"use client";

/**
 * "Your symptoms" on the illness page (v1.40): the person's own symptoms with
 * a one-line summary each, and every occurrence of the last 30 days grouped by
 * day. Renders nothing until a symptom has been defined, so an illness page
 * that never used it looks exactly as before.
 *
 * One `Card` + `TileHeader`, rows divided like the illness day timeline, the
 * intensity as a neutral `TagChip` ("6/10"), and the same kebab + confirm
 * vocabulary as the episode menu.
 */
import { DayLink } from "@/components/day/day-link";
import { useState } from "react";
import {
  Activity,
  Eye,
  EyeOff,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { TagChip } from "@/components/ui/tag-chip";
import { QuickEntrySheets } from "@/components/dashboard/quick-entry-sheets";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import type {
  SymptomDefinitionDTO,
  SymptomEventDTO,
} from "@/lib/symptoms/shared";

import {
  EditSymptomDefinitionSheet,
  EditSymptomEventSheet,
} from "./symptom-edit-sheets";
import { SymptomIcon } from "./symptom-icons";
import {
  useDeleteSymptomDefinition,
  useDeleteSymptomEvent,
  useSymptomDefinitions,
  useSymptomEvents,
  useUpdateSymptomDefinition,
} from "./use-symptoms";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window the section reads, fixed at mount so the query key is stable. */
function useThirtyDayWindow(): { from: string; to: string } {
  const [range] = useState(() => {
    const now = Date.now();
    return {
      from: new Date(now - 30 * DAY_MS).toISOString(),
      // A little slack so an occurrence logged a minute ago with a phone clock
      // running fast is still inside the window.
      to: new Date(now + 10 * 60 * 1000).toISOString(),
    };
  });
  return range;
}

/** One occurrence row: time, symptom, intensity, note, and its actions. */
export function SymptomEventRow({
  event,
  definition,
  annotation,
  actions,
}: {
  event: SymptomEventDTO;
  definition: SymptomDefinitionDTO | undefined;
  /** A short muted tag after the time, e.g. "filed with this episode". */
  annotation?: string;
  actions?: React.ReactNode;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <li
      className="flex items-start justify-between gap-3 py-2.5"
      data-testid="symptom-event-row"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <SymptomIcon
          name={definition?.icon}
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
        />
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">
              {definition?.label ?? t("symptoms.unreadableLabel")}
            </span>
            <TagChip>
              {t("symptoms.intensityPill", { value: event.intensity })}
            </TagChip>
          </div>
          <p className="text-muted-foreground text-xs">
            {fmt.time(new Date(event.occurredAt))}
            {annotation ? ` · ${annotation}` : ""}
          </p>
          {event.note ? (
            <p className="text-sm break-words">{event.note}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </li>
  );
}

/** Occurrences grouped by the person's own calendar day, newest day first. */
export function groupEventsByDay(
  events: SymptomEventDTO[],
  timezone: string,
): Array<{ day: string; at: Date; events: SymptomEventDTO[] }> {
  const groups = new Map<string, SymptomEventDTO[]>();
  for (const event of events) {
    const key = userDayKey(new Date(event.occurredAt), timezone);
    const bucket = groups.get(key) ?? [];
    bucket.push(event);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, list]) => ({
      day,
      at: new Date(list[0].occurredAt),
      events: list,
    }));
}

function summaryLine(
  definition: SymptomDefinitionDTO,
  i18n: ReturnType<typeof useTranslations>,
  fmt: ReturnType<typeof useFormatters>,
): string {
  const { t, tCount } = i18n;
  const { count30d, maxIntensity30d, lastOccurredAt } = definition.recent;
  if (count30d === 0) {
    return lastOccurredAt
      ? t("symptoms.section.summaryNoneRecent", {
          date: fmt.dateShortSmart(new Date(lastOccurredAt)),
        })
      : t("symptoms.section.summaryNever");
  }
  return tCount("symptoms.section.summary", count30d, {
    max: maxIntensity30d ?? 0,
    // Non-null whenever something happened in the window.
    date: lastOccurredAt ? fmt.dateShortSmart(new Date(lastOccurredAt)) : "",
  });
}

function DefinitionMenu({
  definition,
  onEdit,
}: {
  definition: SymptomDefinitionDTO;
  onEdit: () => void;
}) {
  const { t } = useTranslations();
  const update = useUpdateSymptomDefinition();
  const del = useDeleteSymptomDefinition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={t("symptoms.section.menuLabel", {
              symptom: definition.label ?? "",
            })}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            {t("common.edit")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              update.mutate({
                id: definition.id,
                input: { isActive: !definition.isActive },
              })
            }
          >
            {definition.isActive ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
            {definition.isActive
              ? t("symptoms.section.hide")
              : t("symptoms.section.show")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 className="size-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("symptoms.section.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("symptoms.section.deleteBody", {
                symptom: definition.label ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(
                  { id: definition.id, purge: true },
                  { onSuccess: () => setConfirmOpen(false) },
                )
              }
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The per-occurrence kebab: edit, delete (confirmed). */
export function SymptomEventMenu({
  event,
  label,
}: {
  event: SymptomEventDTO;
  label: string;
}) {
  const { t } = useTranslations();
  const del = useDeleteSymptomEvent();
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-9"
            aria-label={t("symptoms.section.eventMenuLabel", {
              symptom: label,
            })}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil className="size-4" />
            {t("common.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            <Trash2 className="size-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing ? (
        <EditSymptomEventSheet
          event={event}
          label={label}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("symptoms.section.deleteEventTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("symptoms.section.deleteEventBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(event.id, {
                  onSuccess: () => setConfirmOpen(false),
                })
              }
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function SymptomsSection() {
  const i18n = useTranslations();
  const { t, tCount } = i18n;
  const fmt = useFormatters();
  const { user } = useAuth();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const canLog = canWriteDomain("illness");
  const canManage = canManageDomain("illness");
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE;
  const range = useThirtyDayWindow();
  const definitions = useSymptomDefinitions(true);
  const events = useSymptomEvents(range.from, range.to);
  const [logOpen, setLogOpen] = useState(false);
  const [editingDefinition, setEditingDefinition] =
    useState<SymptomDefinitionDTO | null>(null);

  const all = definitions.data?.definitions ?? [];
  const byId = new Map(all.map((d) => [d.id, d]));
  const active = all.filter((d) => d.isActive);
  const hidden = all.filter((d) => !d.isActive);
  const days = groupEventsByDay(events.data?.events ?? [], timezone);

  if (definitions.isLoading) return null;
  if (definitions.isError || events.isError) {
    return (
      <QueryErrorCard
        title={t("symptoms.section.loadError")}
        onRetry={() => {
          void definitions.refetch();
          void events.refetch();
        }}
      />
    );
  }
  // Nothing defined yet: the page stays as it was; the quick entry is where a
  // first symptom is defined.
  if (all.length === 0) return null;

  return (
    <Card data-testid="symptoms-section">
      <CardHeader>
        <TileHeader
          icon={Activity}
          title={t("symptoms.section.title")}
          titleAs="h2"
          right={
            canLog ? (
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                onClick={() => setLogOpen(true)}
              >
                <Plus className="size-4" />
                {t("symptoms.section.log")}
              </Button>
            ) : null
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-border divide-y">
          {active.map((definition) => {
            return (
              <li
                key={definition.id}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <SymptomIcon
                    name={definition.icon}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {definition.label ?? t("symptoms.unreadableLabel")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {summaryLine(definition, i18n, fmt)}
                    </p>
                  </div>
                </div>
                {canManage ? (
                  <DefinitionMenu
                    definition={definition}
                    onEdit={() => setEditingDefinition(definition)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>

        {hidden.length > 0 && canManage ? (
          <div className="space-y-1">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tCount("symptoms.section.hidden", hidden.length)}
            </p>
            <ul className="divide-border divide-y">
              {hidden.map((definition) => (
                <li
                  key={definition.id}
                  className="flex items-center justify-between gap-3 py-1.5"
                >
                  <span className="text-muted-foreground truncate text-sm">
                    {definition.label ?? t("symptoms.unreadableLabel")}
                  </span>
                  <DefinitionMenu
                    definition={definition}
                    onEdit={() => setEditingDefinition(definition)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("symptoms.section.recent")}
          </p>
          {days.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("symptoms.section.recentEmpty")}
            </p>
          ) : (
            <div className="space-y-3">
              {days.map((group) => (
                <section key={group.day} className="space-y-0.5">
                  <h3 className="text-sm font-medium">
                    {/* v1.42 — the day heading opens the whole day. */}
                    <DayLink date={group.day}>
                      {fmt.dateWithWeekdaySmart(group.at)}
                    </DayLink>
                  </h3>
                  <ul className="divide-border divide-y">
                    {group.events.map((event) => {
                      const definition = byId.get(event.definitionId);
                      const label =
                        definition?.label ?? t("symptoms.unreadableLabel");
                      return (
                        <SymptomEventRow
                          key={event.id}
                          event={event}
                          definition={definition}
                          actions={
                            canManage ? (
                              <SymptomEventMenu event={event} label={label} />
                            ) : undefined
                          }
                        />
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      {/* The dashboard's own quick-entry sheet, so logging from here is the
          same sheet, with the same discard guard, as from the Add menu. */}
      <QuickEntrySheets
        open={logOpen ? "symptom" : null}
        onClose={() => setLogOpen(false)}
      />

      {editingDefinition ? (
        <EditSymptomDefinitionSheet
          definition={editingDefinition}
          onClose={() => setEditingDefinition(null)}
        />
      ) : null}
    </Card>
  );
}
