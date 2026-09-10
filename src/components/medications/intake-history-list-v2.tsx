"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  History,
  Check,
  SkipForward,
  MoreHorizontal,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  INTAKE_SOURCE_LABEL_KEYS,
  type IntakeSourceValue,
} from "@/lib/i18n/source-labels";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ListRow } from "@/components/ui/list-row";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.4.36 W4a — Lite intake-history surface.
 *
 * The 886-LoC v1 was retired in v1.4.28 (commit 8c81af10) with the
 * note "no other consumer". The standalone medication-history page
 * lost its dose timeline as a side effect — the maintainer reported the page
 * now shows only the heading for non-GLP-1 meds. This v2 restores a
 * read-only timeline for ALL medication kinds without the inline CRUD
 * the v1 carried (edit / delete still happen through the regular
 * medication-intake routes elsewhere).
 *
 * Contract:
 *  - Paginated 25/page via the existing `?limit=&offset=` query on
 *    `GET /api/medications/[id]/intake`. The route already supports
 *    `sortBy=takenAt|scheduledFor|createdAt|source` + `sortDir=asc|desc`.
 *  - v1.4.37 W3: filters server-side with `?status=completed` so the
 *    detail-page list shows only rows the user actually actioned
 *    (taken OR skipped). The ambiguous "missed / never confirmed"
 *    rows (`takenAt IS NULL AND skipped = false`) stay hidden here
 *    and remain visible on the calendar / today surfaces. This
 *    restores the v1 component's effective behaviour and fixes the
 *    bug where such rows rendered as "Eingenommen" with an empty
 *    leading column.
 *  - Sortable by `takenAt` (default) and `scheduledFor`. Click the
 *    header to toggle the direction; switching column resets to desc.
 *  - Status chip: green Check + "Eingenommen" for taken rows,
 *    outline SkipForward + "Übersprungen" for skipped rows. The
 *    component never labels a row both at once.
 *  - Source badge surfaces where the intake was logged — WEB → "Web",
 *    API → "iOS App", REMINDER → "Reminder", IMPORT → "Import",
 *    APPLE_HEALTH → "Apple Health" — wrapped in a muted "via {origin}"
 *    caption next to the status. The labels map the coarse `IntakeSource`
 *    enum to the practical client per the existing `medications.source*`
 *    keys; there is no finer client field.
 *  - Empty state copy + CTA back to the daily intake page.
 *  - No edit-in-row, no delete buttons.
 */

export interface IntakeEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: IntakeSourceValue;
  createdAt: string;
}

interface IntakeListResponse {
  events: IntakeEvent[];
  meta: { total: number; limit: number; offset: number };
}

/**
 * v1.5.5 F-1 C-2 — optional selection contract. When the wrapper
 * passes `selection`, each row renders a leading `<Checkbox>` that
 * mirrors the selected set. Single mode hides the bulk-toolbar; multi
 * mode wires through to `<BulkDeleteToolbar>`. The contract lives on
 * the list rather than on the wrapper so a future surface (e.g. the
 * full /history page) can re-use the same shape.
 */
export interface IntakeHistoryListV2Selection {
  mode: "single" | "multi";
  selected: Set<string>;
  onToggle: (id: string) => void;
}

interface IntakeHistoryListV2Props {
  medicationId: string;
  /** Override the default page size — primarily for tests. */
  pageSize?: number;
  /**
   * v1.5.5 F-1 C-2 — per-row Bearbeiten callback. When provided the
   * row renders a kebab `<DropdownMenu>` with an Edit action. v1.5.6
   * G-1 §9 Q1: threads the whole `IntakeEvent` (not just the id) so
   * the edit dialog seeds from the row's real `takenAt` / `skipped`
   * instead of an empty stub.
   */
  onEditIntake?: (event: IntakeEvent) => void;
  /**
   * v1.5.5 F-1 C-2 — per-row Löschen callback. When provided the row
   * renders a kebab `<DropdownMenu>` with a Delete action.
   */
  onDeleteIntake?: (eventId: string) => void;
  /**
   * v1.5.5 F-1 C-2 — selection contract; see `IntakeHistoryListV2Selection`.
   */
  selection?: IntakeHistoryListV2Selection;
  /**
   * v1.7.0 — initial sort column. Defaults to `"takenAt"` to preserve
   * the detail-page preview behaviour; the full-history view passes
   * `"scheduledFor"` so skipped rows (`takenAt: null`) never float to
   * the top of the descending order (O-1).
   */
  defaultSortBy?: IntakeHistorySortKey;
}

export type IntakeHistorySortKey = "takenAt" | "scheduledFor";
type SortKey = IntakeHistorySortKey;

const DEFAULT_PAGE_SIZE = 25;
/**
 * v1.4.37 W3 — pinned to "completed" for the detail-page surface so
 * planned / missed rows never leak into the table. Lifted to a
 * module-level constant so the queryKey stays stable across renders
 * and `setQueryData` in tests can pre-seed the same shape.
 */
const STATUS_FILTER = "completed";

/**
 * The row's outcome as a stable token, carried on both layouts' rows as
 * `data-status`. The visible outcome is a translated badge that renders at a
 * different size on each layout, so it is not a thing an end-to-end journey
 * can address; the branch itself is one line and already computed twice.
 * "unknown" cannot occur while `STATUS_FILTER` holds — it is what a malformed
 * row would say rather than quietly reading as taken.
 */
function rowStatus(isTaken: boolean, isSkipped: boolean): string {
  if (isTaken) return "taken";
  return isSkipped ? "skipped" : "unknown";
}

export function IntakeHistoryListV2({
  medicationId,
  pageSize = DEFAULT_PAGE_SIZE,
  onEditIntake,
  onDeleteIntake,
  selection,
  defaultSortBy = "takenAt",
}: IntakeHistoryListV2Props) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const formatters = useFormatters();
  // v1.30 mobile audit (M-2) — the desktop table carries two full datetime
  // columns plus status + source + kebab, forcing horizontal scroll on
  // every phone. SSR-safe gate (mirrors `measurement-list.tsx`'s H3 split):
  // resolves to the desktop table on the server + first paint, then flips
  // to the stacked list after hydration.
  const isMobile = useIsMobile("md");

  // v1.5.5 F-1 C-2 — the kebab + checkbox columns are gated by the
  // caller-passed callbacks. The list never assumes a wrapper; it
  // renders the extra columns only when explicitly opted-in.
  const showRowActions = Boolean(onEditIntake || onDeleteIntake);
  const showSelection = selection?.mode === "multi";

  const [sortBy, setSortBy] = useState<SortKey>(defaultSortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);

  const offset = page * pageSize;

  const { data, isLoading, isError, refetch } = useQuery<IntakeListResponse>({
    queryKey: queryKeys.medicationIntakeList(medicationId, {
      sortBy,
      sortDir,
      limit: pageSize,
      offset,
      status: STATUS_FILTER,
    }),
    queryFn: async () => {
      const params = new URLSearchParams({
        sortBy,
        sortDir,
        limit: String(pageSize),
        offset: String(offset),
        status: STATUS_FILTER,
      });
      return apiGet<IntakeListResponse>(
        `/api/medications/${medicationId}/intake?${params.toString()}`,
      );
    },
    enabled: isAuthenticated,
  });

  const sourceLabels: Record<IntakeSourceValue, string> = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(INTAKE_SOURCE_LABEL_KEYS).map(([source, key]) => [
          source,
          t(key),
        ]),
      ) as Record<IntakeSourceValue, string>,
    [t],
  );

  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const events = data?.events ?? [];

  const toggleSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
    setPage(0);
  };

  const sortIndicator = (key: SortKey) => {
    if (key !== sortBy) {
      return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-50" />;
    }
    return sortDir === "desc" ? (
      <ArrowDown className="ml-1 inline h-3 w-3" />
    ) : (
      <ArrowUp className="ml-1 inline h-3 w-3" />
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("medications.intakeHistory")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
          </div>
        ) : isError ? (
          <QueryErrorCard
            title={t("medications.loadFailed")}
            onRetry={() => void refetch()}
          />
        ) : events.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<History className="size-6" />}
            title={t("medications.intakeHistoryEmptyTitle")}
            description={t("medications.intakeHistoryEmptyDescription")}
            action={
              <Button asChild size="sm">
                <Link href="/medications">
                  {t("medications.intakeHistoryEmptyAction")}
                </Link>
              </Button>
            }
          />
        ) : (
          <>
            {/* v1.30 mobile audit (M-2) — the two-datetime-column table is
                contained (Table self-wraps in overflow-x-auto) but forces
                sideways scroll of a primary history surface on every phone.
                Below `md` it swaps for a stacked card list (the
                `measurement-list.tsx` pattern); only the active layout
                mounts, mirroring that component's SSR-safe gate. */}
            {!isMobile && (
              <Table>
                <TableHeader>
                  <TableRow>
                    {showSelection && (
                      <TableHead
                        className="w-8"
                        data-slot="intake-history-select-col"
                      />
                    )}
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => toggleSort("takenAt")}
                        className="focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:min-h-9"
                        aria-label={t("medications.intakeHistorySortByTaken")}
                      >
                        {t("medications.intakeHistoryColTaken")}
                        {sortIndicator("takenAt")}
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        type="button"
                        onClick={() => toggleSort("scheduledFor")}
                        className="focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md font-medium hover:underline focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none sm:min-h-9"
                        aria-label={t(
                          "medications.intakeHistorySortByScheduled",
                        )}
                      >
                        {t("medications.intakeHistoryColScheduled")}
                        {sortIndicator("scheduledFor")}
                      </button>
                    </TableHead>
                    <TableHead>
                      {t("medications.intakeHistoryColStatus")}
                    </TableHead>
                    <TableHead>
                      {t("medications.intakeHistoryColSource")}
                    </TableHead>
                    {showRowActions && (
                      <TableHead
                        className="w-8"
                        data-slot="intake-history-actions-col"
                      />
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => {
                    // v1.4.37 W3 — `status=completed` server filter
                    // guarantees that every row is either a taken or a
                    // skipped event. We derive the branch from the data
                    // itself rather than trusting a single `skipped`
                    // flag so a malformed row (e.g. `skipped:false` with
                    // `takenAt:null`, the v1.4.36 regression) never
                    // sneaks past as "Eingenommen".
                    const isTaken = !event.skipped && !!event.takenAt;
                    const isSkipped = event.skipped;
                    const isSelected =
                      selection?.selected.has(event.id) ?? false;
                    return (
                      <TableRow
                        key={event.id}
                        data-slot="intake-history-row"
                        data-status={rowStatus(isTaken, isSkipped)}
                      >
                        {showSelection && (
                          <TableCell className="w-8">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() =>
                                selection?.onToggle(event.id)
                              }
                              aria-label={t(
                                "medications.detail.intake.selection.rowToggleLabel",
                              )}
                              data-slot="intake-history-row-select"
                            />
                          </TableCell>
                        )}
                        <TableCell className="text-sm">
                          {/* v1.7.0 — the date column is always populated:
                              taken rows show `takenAt`, skipped rows fall
                              back to `scheduledFor` with a muted
                              "(planned)" suffix so the chronological
                              order stays clean and no `—` row floats. */}
                          {event.takenAt ? (
                            formatters.dateTime(event.takenAt)
                          ) : (
                            <>
                              {formatters.dateTime(event.scheduledFor)}{" "}
                              <span className="text-muted-foreground text-xs">
                                ({t("medications.detail.history.plannedSuffix")}
                                )
                              </span>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatters.dateTime(event.scheduledFor)}
                        </TableCell>
                        <TableCell>
                          {isTaken ? (
                            <Badge
                              variant="secondary"
                              className="bg-success/15 text-success gap-1 text-xs"
                            >
                              <Check aria-hidden="true" className="h-3 w-3" />
                              {t("medications.intakeHistoryStatusTaken")}
                            </Badge>
                          ) : isSkipped ? (
                            <Badge
                              variant="outline"
                              className="text-muted-foreground gap-1 text-xs"
                            >
                              <SkipForward
                                aria-hidden="true"
                                className="h-3 w-3"
                              />
                              {t("medications.intakeHistoryStatusSkipped")}
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className="text-muted-foreground text-xs font-normal"
                          >
                            {t("medications.intakeSourceVia", {
                              origin:
                                sourceLabels[event.source] ?? event.source,
                            })}
                          </Badge>
                        </TableCell>
                        {showRowActions && (
                          <TableCell className="w-8 text-right">
                            <IntakeRowActions
                              event={event}
                              onEditIntake={onEditIntake}
                              onDeleteIntake={onDeleteIntake}
                              t={t}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            {isMobile && (
              <div className="space-y-2" data-slot="intake-history-mobile">
                {events.map((event) => {
                  const isTaken = !event.skipped && !!event.takenAt;
                  const isSkipped = event.skipped;
                  const isSelected = selection?.selected.has(event.id) ?? false;
                  return (
                    <ListRow
                      key={event.id}
                      data-slot="intake-history-row"
                      data-status={rowStatus(isTaken, isSkipped)}
                      data-state={isSelected ? "selected" : undefined}
                      className="bg-card border-border data-[state=selected]:border-primary/60 data-[state=selected]:bg-primary/5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2">
                          {showSelection && (
                            <div className="flex size-11 shrink-0 items-center justify-center">
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() =>
                                  selection?.onToggle(event.id)
                                }
                                aria-label={t(
                                  "medications.detail.intake.selection.rowToggleLabel",
                                )}
                                data-slot="intake-history-row-select"
                                className="relative after:absolute after:-inset-3.5"
                              />
                            </div>
                          )}
                          <div className="min-w-0 space-y-1">
                            <p className="text-sm font-medium">
                              {event.takenAt ? (
                                formatters.dateTime(event.takenAt)
                              ) : (
                                <>
                                  {formatters.dateTime(event.scheduledFor)}{" "}
                                  <span className="text-muted-foreground text-xs font-normal">
                                    (
                                    {t(
                                      "medications.detail.history.plannedSuffix",
                                    )}
                                    )
                                  </span>
                                </>
                              )}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              {t("medications.intakeHistoryColScheduled")}:{" "}
                              {formatters.dateTime(event.scheduledFor)}
                            </p>
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                              {isTaken ? (
                                <Badge
                                  variant="secondary"
                                  className="bg-success/15 text-success gap-1 text-xs"
                                >
                                  <Check
                                    aria-hidden="true"
                                    className="h-3 w-3"
                                  />
                                  {t("medications.intakeHistoryStatusTaken")}
                                </Badge>
                              ) : isSkipped ? (
                                <Badge
                                  variant="outline"
                                  className="text-muted-foreground gap-1 text-xs"
                                >
                                  <SkipForward
                                    aria-hidden="true"
                                    className="h-3 w-3"
                                  />
                                  {t("medications.intakeHistoryStatusSkipped")}
                                </Badge>
                              ) : null}
                              <Badge
                                variant="outline"
                                className="text-muted-foreground text-xs font-normal"
                              >
                                {t("medications.intakeSourceVia", {
                                  origin:
                                    sourceLabels[event.source] ?? event.source,
                                })}
                              </Badge>
                            </div>
                          </div>
                        </div>
                        {showRowActions && (
                          <IntakeRowActions
                            event={event}
                            onEditIntake={onEditIntake}
                            onDeleteIntake={onDeleteIntake}
                            t={t}
                          />
                        )}
                      </div>
                    </ListRow>
                  );
                })}
              </div>
            )}

            {totalPages > 1 && (
              <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
                <span>
                  {t("medications.intakeHistoryPageInfo", {
                    page: page + 1,
                    total: totalPages,
                    count: total,
                  })}
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    {t("medications.intakeHistoryPrev")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 sm:min-h-9"
                    onClick={() =>
                      setPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                    disabled={page >= totalPages - 1}
                  >
                    {t("medications.intakeHistoryNext")}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Per-row Bearbeiten/Löschen kebab, shared by the desktop table row and the
 * mobile stacked-card row. v1.30 mobile audit (M-1) — was a hard `h-8 w-8`
 * (32 px), sub-floor in an edit flow and inconsistent with the sort headers
 * in this same file and the dose-history ledger's kebab; now `size-11
 * sm:size-9` like the rest of the app's icon-button floor.
 */
function IntakeRowActions({
  event,
  onEditIntake,
  onDeleteIntake,
  t,
}: {
  event: IntakeEvent;
  onEditIntake?: (event: IntakeEvent) => void;
  onDeleteIntake?: (eventId: string) => void;
  t: ReturnType<typeof useTranslations>["t"];
}) {
  // v1.36.x — editing or deleting a recorded dose is the owner's.
  const { canManageDomain } = useRecordCapabilities();
  const canManageMedications = canManageDomain("medications");
  if (!canManageMedications) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 sm:size-9"
          aria-label={t("medications.detail.intake.rowActions.openMenu")}
          data-slot="intake-history-row-kebab"
        >
          <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onEditIntake && (
          <DropdownMenuItem
            onSelect={() => onEditIntake(event)}
            data-slot="intake-history-row-edit"
          >
            {t("medications.detail.intake.rowActions.edit")}
          </DropdownMenuItem>
        )}
        {onDeleteIntake && (
          <DropdownMenuItem
            onSelect={() => onDeleteIntake(event.id)}
            data-slot="intake-history-row-delete"
            className="text-destructive focus:text-destructive"
          >
            {t("medications.detail.intake.rowActions.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
