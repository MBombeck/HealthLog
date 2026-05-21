"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Activity,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  MoreHorizontal,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { CUMULATIVE_DAY_SUM_TYPES } from "@/lib/measurements/cumulative-day-sum";
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";
import { DateTimeInput } from "@/components/ui/date-input";
import {
  MEASUREMENT_TYPE_LABEL_KEYS as TYPE_LABEL_KEYS,
  MEASUREMENT_TYPE_ICONS as TYPE_ICONS,
  MEASUREMENT_TYPE_COLORS as TYPE_COLORS,
} from "./measurement-list-meta";

/**
 * v1.4.37 W7c — cumulative HK types whose list view collapses to one
 * row per user-TZ day with an expand-chevron drill-down to the
 * per-sample chunks. Mirrors the server-side
 * `CUMULATIVE_DAY_SUM_TYPES` so the route's `groupBy=day` branch and
 * the client's filter-detection agree on the same five identifiers.
 */
const CUMULATIVE_TYPES = new Set<string>(CUMULATIVE_DAY_SUM_TYPES);

interface Measurement {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: string;
  notes: string | null;
  /**
   * v1.4.37 W7c — present only on collapsed daily rows returned by
   * `?type=…&groupBy=day`. Drives the expand chevron + the drill-down
   * fetch keyed by the user's calendar day.
   */
  dayKey?: string;
  sampleCount?: number;
}

interface MeasurementListProps {
  onEdit?: (m: Measurement) => void;
  /**
   * v1.4.15 phase-C5: optional callback wired by the parent page so
   * the empty-state's "Add your first measurement" CTA opens the same
   * dialog the header button does. When undefined we hide the button
   * (fallback to the header CTA) instead of crashing.
   */
  onAddFirst?: () => void;
}

const PAGE_SIZE = 25;
const MAX_COMMENT_LENGTH = 25;

function truncateComment(comment: string): string {
  if (comment.length <= MAX_COMMENT_LENGTH) return comment;
  return `${comment.slice(0, MAX_COMMENT_LENGTH - 1)}…`;
}

function toDateTimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/**
 * Render the `MeasurementSource` enum (`MANUAL` / `WITHINGS` / `IMPORT`
 * / `APPLE_HEALTH`) using the existing `measurements.source*`
 * translation keys instead of leaking the SCREAMING_SNAKE enum into
 * the table cell.
 */
function formatMeasurementSource(
  source: string,
  t: ReturnType<typeof useTranslations>["t"],
) {
  if (source === "WITHINGS") return t("measurements.sourceWithings");
  if (source === "IMPORT") return t("measurements.sourceImport");
  if (source === "MANUAL") return t("measurements.sourceManual");
  if (source === "APPLE_HEALTH") return t("measurements.sourceAppleHealth");
  return source;
}

/**
 * Per-source badge colour. `APPLE_HEALTH` gets the Dracula pink that
 * matches the iOS app's accent; everything else falls back to the
 * shadcn outline default (no class override).
 */
function sourceBadgeClass(source: string): string {
  if (source === "APPLE_HEALTH") {
    return "border-dracula-pink/50 bg-dracula-pink/15 text-dracula-pink";
  }
  return "";
}

export function MeasurementList({ onEdit, onAddFirst }: MeasurementListProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilterRaw] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("measuredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // v1.4.37 W7c — set of dayKeys whose drill-down is currently
  // expanded. Each key maps to a one-shot query that lazy-fetches
  // the per-sample rows for that calendar day on first open.
  const [expandedDayKeys, setExpandedDayKeys] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleExpand(dayKey: string) {
    setExpandedDayKeys((prev) => {
      const next = new Set(prev);
      if (next.has(dayKey)) next.delete(dayKey);
      else next.add(dayKey);
      return next;
    });
  }

  const [editing, setEditing] = useState<Measurement | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editMeasuredAt, setEditMeasuredAt] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // v1.4.27 MB3 — link the edit dialog error banner to the inputs via
  // `aria-describedby` so screen readers announce the validation
  // failure when the user submits an invalid value or timestamp.
  const editErrorId = useId();
  const editErrorDescriptor = editError ? editErrorId : undefined;
  // v1.4.27 R4 RC2 — Sheet-branch sticky-pinned footer slot.
  const editFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  const setTypeFilter = (value: string) => {
    setTypeFilterRaw(value);
    setPage(1);
  };

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir(column === "measuredAt" ? "desc" : "asc");
    }
    setPage(1);
  }

  // v1.4.37 W7c — when the type filter is a cumulative HK type
  // (steps, active energy, distance, flights, daylight) the list
  // collapses to one row per user-TZ day via the route's
  // `groupBy=day` mode. The chevron in the row drills back into the
  // per-sample chunks via a separate `dayKey=…` query. Matches the
  // Apple Health.app / Garmin / Withings pattern documented in
  // `.planning/research/v1437-step-aggregation.md` §"How the leaders
  // do it" — never list per-sample chunks as the default view.
  const isCumulativeFilter = CUMULATIVE_TYPES.has(typeFilter);

  const { data, isLoading } = useQuery({
    queryKey: [
      "measurements",
      typeFilter === "ALL" ? undefined : typeFilter,
      page,
      sortBy,
      sortDir,
      isCumulativeFilter ? "groupBy=day" : "raw",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter !== "ALL") params.set("type", typeFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      if (isCumulativeFilter) {
        params.set("groupBy", "day");
        // The collapsed mode synthesises one row per day from the
        // window of raw samples. Use the server-side ceiling (5000)
        // so a chatty pre-drain Apple-Watch account (≈200 per-sample
        // chunks/day on the busiest days) still fills several screens
        // of daily rows before the nightly drain reduces each day to
        // a single `stats:` row. Post-drain the scan is trivially
        // short — every day reduces to 1 row.
        params.set("limit", "5000");
        // The synthesised rows live entirely in the collapse branch
        // — pagination/offset don't apply on the server side. Reset
        // the offset so a sort-direction flip doesn't paginate into
        // an empty slice.
        params.set("offset", "0");
      }
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        measurements: Measurement[];
        meta: { total: number };
      };
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/measurements/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, measurementDependentKeys);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      value,
      measuredAt,
      notes,
    }: {
      id: string;
      value: number;
      measuredAt: string;
      notes: string | null;
    }) => {
      const res = await fetch(`/api/measurements/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value,
          measuredAt,
          notes,
        }),
      });

      const json = (await res.json()) as {
        error?: string;
        meta?: { errorCode?: string };
      };
      if (!res.ok) {
        // v1.4.28 FB-B1 — the PUT route now returns a 409 with
        // `meta.errorCode === "measurement.duplicate_timestamp"` when
        // the edit collides with an existing row's
        // `(type, measuredAt, source, sleepStage)` tuple. Forward the
        // code alongside the message so `onError` can pick the
        // localised string.
        const err = new Error(json.error ?? "Update failed") as Error & {
          errorCode?: string;
          status?: number;
        };
        err.errorCode = json.meta?.errorCode;
        err.status = res.status;
        throw err;
      }
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => {
      const errWithCode = err as Error & { errorCode?: string };
      if (errWithCode.errorCode === "measurement.duplicate_timestamp") {
        setEditError(t("measurements.duplicateTimestamp"));
        return;
      }
      setEditError(
        err instanceof Error ? err.message : t("measurements.saveError"),
      );
    },
  });

  // v1.4.37 W7c — the collapsed daily view paints up to 5000
  // synthesised rows in one shot (one row per day for the
  // configured window). Pagination would force a second server
  // round-trip that re-fires the same scan, so the day-grouped
  // path collapses to a single page. Per-sample lists continue to
  // paginate at PAGE_SIZE = 25.
  const totalPages =
    data && !isCumulativeFilter
      ? Math.ceil(data.meta.total / PAGE_SIZE)
      : 0;

  function startEdit(measurement: Measurement) {
    if (onEdit) {
      onEdit(measurement);
      return;
    }

    setEditing(measurement);
    setEditValue(String(measurement.value));
    setEditMeasuredAt(toDateTimeLocalValue(measurement.measuredAt));
    setEditNotes((measurement.notes ?? "").slice(0, MAX_COMMENT_LENGTH));
    setEditError(null);
  }

  function closeEdit() {
    if (updateMutation.isPending || deleteMutation.isPending) return;
    setEditing(null);
    setEditError(null);
    setEditDeleteDialogOpen(false);
  }

  async function deleteEditingMeasurement() {
    if (!editing) return;

    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      closeEdit();
    } catch {
      setEditError(t("measurements.deleteError"));
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;

    const parsedValue = Number(editValue);
    if (!Number.isFinite(parsedValue)) {
      setEditError(t("measurements.invalidValue"));
      return;
    }

    const measuredDate = new Date(editMeasuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("measurements.invalidTimestamp"));
      return;
    }

    setEditError(null);
    updateMutation.mutate({
      id: editing.id,
      value: parsedValue,
      measuredAt: measuredDate.toISOString(),
      notes: editNotes.trim() ? editNotes.trim() : null,
    });
  }

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("measurements.loginRequired")}
      </p>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* v1.4.27 MB7 / CF-46 — the filter row stacks the SelectTrigger
            and the count caption vertically on `<sm` so the trigger
            fills the column and the count drops to a separate line.
            Pre-fix the trigger had a fixed `w-48` (192 px) which on
            Pixel 5 (375 px content width) left only ~120 px for the
            count, which wrapped to 2 lines. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              className="w-full sm:w-48"
              aria-label={t("measurements.filterByType")}
            >
              <SelectValue placeholder={t("measurements.allTypes")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("measurements.allTypes")}</SelectItem>
              {Object.entries(TYPE_LABEL_KEYS).map(([val, labelKey]) => (
                <SelectItem key={val} value={val}>
                  {t(labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data?.meta?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {t("measurements.measurementCount", {
                count: fmt.integer(data.meta.total),
              })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !data?.measurements?.length ? (
          // v1.4.15 phase-C5: replaces the bare-text empty rectangle.
          // Filter-aware copy distinguishes brand-new accounts ("no
          // measurements yet") from filtered-out lists ("no measurements
          // match this filter") and exposes the right CTA for each
          // case.
          <EmptyState
            icon={<Activity className="size-6" />}
            title={
              typeFilter === "ALL"
                ? t("measurements.emptyTitle")
                : t("measurements.emptyFilteredTitle")
            }
            description={
              typeFilter === "ALL"
                ? t("measurements.emptyDescription")
                : t("measurements.emptyFilteredDescription")
            }
            action={
              typeFilter !== "ALL" ? (
                <Button
                  variant="outline"
                  onClick={() => setTypeFilter("ALL")}
                >
                  {t("measurements.emptyResetFilter")}
                </Button>
              ) : onAddFirst ? (
                <Button onClick={onAddFirst}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t("measurements.emptyAddFirst")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop table */}
            <div className="bg-card border-border hidden overflow-hidden rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28 pl-4">
                      {t("measurements.type")}
                    </TableHead>
                    <SortableHead
                      column="value"
                      label={t("measurements.value")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      column="measuredAt"
                      label={t("measurements.date")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <TableHead className="w-56">
                      {t("measurements.comment")}
                    </TableHead>
                    <SortableHead
                      column="source"
                      label={t("measurements.source")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-20"
                    />
                    <TableHead className="w-20 pr-4 text-right">
                      {t("measurements.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.measurements.map((m) => {
                    const isGrouped =
                      m.dayKey !== undefined && m.sampleCount !== undefined;
                    const isExpanded = isGrouped
                      ? expandedDayKeys.has(m.dayKey as string)
                      : false;
                    // v1.4.38 W-D P1-1 — stable drill-down id so the
                    // disclosure chevron can thread aria-controls to the
                    // expanded panel. dayKey is unique per row when
                    // grouped; fall back to m.id otherwise.
                    const drilldownId = `drilldown-desktop-${m.dayKey ?? m.id}`;
                    return (
                      <Fragment key={m.id}>
                        <TableRow>
                          <TableCell className="pl-4">
                            <Badge
                              variant="secondary"
                              className={TYPE_COLORS[m.type] ?? ""}
                            >
                              {TYPE_LABEL_KEYS[m.type]
                                ? t(TYPE_LABEL_KEYS[m.type])
                                : m.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-semibold tabular-nums">
                            {/* v1.4.39.3 — non-grouped rows render the
                                stored value with its native precision
                                (`fmt.number` honours up to 3 fraction
                                digits by default, drops trailing zeros)
                                so a 78.4 kg weight reading stops
                                truncating to "78". Grouped rows are
                                cumulative-type day aggregates (steps,
                                distance, etc.) and stay on `fmt.integer`
                                because the underlying readings are
                                integer-only by definition. */}
                            {isGrouped
                              ? fmt.integer(m.value)
                              : fmt.number(m.value)}{" "}
                            {m.unit}
                            {isGrouped && (
                              <span className="text-muted-foreground ml-2 text-xs font-normal">
                                {t("measurements.dailyTotalCaption", {
                                  count: fmt.integer(
                                    m.sampleCount as number,
                                  ),
                                })}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDateTime(m.measuredAt)}
                          </TableCell>
                          <TableCell className="text-sm">
                            {m.notes ? (
                              <span title={m.notes}>
                                {truncateComment(m.notes)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {m.source !== "MANUAL" && (
                              <Badge
                                variant="outline"
                                data-testid="measurement-source-badge"
                                className={`text-xs ${sourceBadgeClass(m.source)}`.trim()}
                              >
                                {formatMeasurementSource(m.source, t)}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="pr-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {isGrouped ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-10 w-10"
                                  data-testid="measurement-day-expand"
                                  onClick={() =>
                                    toggleExpand(m.dayKey as string)
                                  }
                                  aria-expanded={isExpanded}
                                  aria-controls={drilldownId}
                                  aria-label={
                                    isExpanded
                                      ? t("measurements.collapseDay")
                                      : t("measurements.expandDay")
                                  }
                                >
                                  <ChevronDown
                                    className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                                  />
                                </Button>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-10 w-10"
                                    onClick={() => startEdit(m)}
                                    aria-label={t("common.edit")}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <DeleteButton
                                    onConfirm={() =>
                                      deleteMutation.mutate(m.id)
                                    }
                                  />
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        {isGrouped && isExpanded && (
                          <TableRow id={drilldownId}>
                            <TableCell colSpan={6} className="p-0">
                              <DayDrillDown
                                type={m.type}
                                dayKey={m.dayKey as string}
                                unit={m.unit}
                                layout="desktop"
                              />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile list */}
            <div className="space-y-2 md:hidden">
              {data.measurements.map((m) => {
                const Icon = TYPE_ICONS[m.type];
                const isGrouped =
                  m.dayKey !== undefined && m.sampleCount !== undefined;
                const isExpanded = isGrouped
                  ? expandedDayKeys.has(m.dayKey as string)
                  : false;
                // v1.4.38 W-D P1-1 — see desktop counterpart.
                const drilldownId = `drilldown-mobile-${m.dayKey ?? m.id}`;
                return (
                  <div
                    key={m.id}
                    className="bg-card border-border rounded-lg border p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5 overflow-hidden">
                        {Icon && (
                          <div
                            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLORS[m.type] ?? ""}`}
                          >
                            <Icon className="h-4 w-4" />
                          </div>
                        )}
                        <div className="min-w-0">
                          {/* v1.4.27 MB7 / CF-76 — bump the metadata
                              badges from `text-[10px]` to `text-[11px]`
                              so the legibility floor (12 px is the
                              mobile baseline; 11 px is the lowest
                              tolerated value for non-primary chrome)
                              holds across the row. */}
                          {(m.type === "BLOOD_PRESSURE_SYS" ||
                            m.type === "BLOOD_PRESSURE_DIA") && (
                            <Badge
                              variant="outline"
                              className="mr-1.5 h-5 px-1 text-[11px]"
                            >
                              {t(TYPE_LABEL_KEYS[m.type])}
                            </Badge>
                          )}
                          <span className="font-semibold tabular-nums">
                            {/* v1.4.39.3 — mirror the desktop table:
                                grouped daily aggregates stay integer,
                                non-grouped single readings render with
                                their native decimal precision so
                                "78.4 kg" no longer truncates to "78". */}
                            {isGrouped
                              ? fmt.integer(m.value)
                              : fmt.number(m.value)}{" "}
                            {m.unit}
                          </span>
                          {isGrouped && (
                            <span className="text-muted-foreground ml-1.5 text-[11px]">
                              {t("measurements.dailyTotalCaption", {
                                count: fmt.integer(m.sampleCount as number),
                              })}
                            </span>
                          )}
                          <p className="text-muted-foreground truncate text-xs">
                            <span>{formatDateTime(m.measuredAt)}</span>
                            {m.source !== "MANUAL" && (
                              <Badge
                                variant="outline"
                                data-testid="measurement-source-badge"
                                className={`ml-1.5 h-4 px-1 text-[11px] ${sourceBadgeClass(m.source)}`.trim()}
                              >
                                {formatMeasurementSource(m.source, t)}
                              </Badge>
                            )}
                          </p>
                          {m.notes && (
                            <p className="text-muted-foreground truncate text-xs">
                              {truncateComment(m.notes)}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isGrouped ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11"
                            data-testid="measurement-day-expand"
                            onClick={() => toggleExpand(m.dayKey as string)}
                            aria-expanded={isExpanded}
                            aria-controls={drilldownId}
                            aria-label={
                              isExpanded
                                ? t("measurements.collapseDay")
                                : t("measurements.expandDay")
                            }
                          >
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            />
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              onClick={() => startEdit(m)}
                              aria-label={t("common.edit")}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <DeleteButton
                              className="size-11"
                              onConfirm={() => deleteMutation.mutate(m.id)}
                            />
                          </>
                        )}
                      </div>
                    </div>
                    {isGrouped && isExpanded && (
                      <div id={drilldownId}>
                        <DayDrillDown
                          type={m.type}
                          dayKey={m.dayKey as string}
                          unit={m.unit}
                          layout="mobile"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {t("measurements.pageInfo", {
                page: String(page),
                total: String(totalPages),
              })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                aria-label={t("measurements.previousPage")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label={t("measurements.nextPage")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <ResponsiveSheet
        open={!!editing}
        onOpenChange={(open) => !open && closeEdit()}
        title={t("measurements.editMeasurement")}
        footer={<div ref={setEditFooterEl} className="flex w-full" />}
      >
          {editing && (
            <form
              id={editFormId}
              onSubmit={submitEdit}
              className="space-y-4"
            >
              <div className="flex items-center gap-1.5">
                <Label className="shrink-0">{t("measurements.type")}</Label>
                <span className="text-sm leading-none font-medium">
                  {TYPE_LABEL_KEYS[editing.type]
                    ? t(TYPE_LABEL_KEYS[editing.type])
                    : editing.type}
                </span>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-value">
                  {t("measurements.valueWithUnit", { unit: editing.unit })}
                </Label>
                <Input
                  id="edit-value"
                  type="number"
                  enterKeyHint="next"
                  step="any"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-measuredAt">
                  {t("measurements.timestamp")}
                </Label>
                <DateTimeInput
                  id="edit-measuredAt"
                  value={editMeasuredAt}
                  onChange={(e) => setEditMeasuredAt(e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="edit-notes">
                    {t("measurements.notes")} ({t("common.optional")})
                  </Label>
                  <span className="text-muted-foreground text-xs">
                    {editNotes.length}/{MAX_COMMENT_LENGTH}
                  </span>
                </div>
                <Input
                  id="edit-notes"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  maxLength={MAX_COMMENT_LENGTH}
                  enterKeyHint="done"
                  autoCapitalize="sentences"
                />
              </div>

              {editError && (
                <div
                  id={editErrorId}
                  role="alert"
                  aria-live="assertive"
                  className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
                >
                  {editError}
                </div>
              )}

              {editFooterEl
                ? createPortal(
                    <div className="flex w-full items-center justify-between gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-11"
                            disabled={
                              updateMutation.isPending ||
                              deleteMutation.isPending
                            }
                            aria-label={t("common.moreOptions")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setEditDeleteDialogOpen(true)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={closeEdit}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          type="submit"
                          form={editFormId}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {updateMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : null}
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>,
                    editFooterEl,
                  )
                : null}

              <AlertDialog
                open={editDeleteDialogOpen}
                onOpenChange={setEditDeleteDialogOpen}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("measurements.deleteConfirmTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("measurements.deleteConfirmDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>
                      {t("common.cancel")}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={deleteEditingMeasurement}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          )}
      </ResponsiveSheet>
    </>
  );
}

/**
 * v1.4.37 W7c — lazy drill-down for a collapsed cumulative-type day.
 * Fires a separate `GET /api/measurements?type=…&dayKey=…` only when
 * the row is expanded; the result is rendered as a nested list of the
 * per-sample chunks that summed into the parent row's daily total.
 */
function DayDrillDown({
  type,
  dayKey,
  unit,
  layout,
}: {
  type: string;
  dayKey: string;
  unit: string;
  layout: "desktop" | "mobile";
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["measurement-drilldown", type, dayKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("type", type);
      params.set("dayKey", dayKey);
      params.set("sortDir", "asc");
      const res = await fetch(`/api/measurements?${params}`);
      if (!res.ok) throw new Error("Failed to fetch drill-down");
      const json = await res.json();
      return json.data as { measurements: Measurement[] };
    },
    enabled: isAuthenticated,
    // The drill-down is per-day — once fetched it rarely needs to
    // re-fetch (the underlying day has already stabilised for
    // anything older than the drain's 36 h cutoff). Keep it cached
    // for the session.
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        {t("common.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="text-destructive py-2 text-xs">
        {t("measurements.loadError")}
      </div>
    );
  }
  const rows = data?.measurements ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground py-2 text-xs">
        {t("measurements.emptyDescription")}
      </div>
    );
  }
  if (layout === "desktop") {
    return (
      <div className="bg-muted/40 space-y-1 p-2">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 px-2 py-1 text-xs"
          >
            <span className="text-muted-foreground tabular-nums">
              {formatDateTime(s.measuredAt)}
            </span>
            <span className="font-medium tabular-nums">
              {s.value} {unit}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bg-muted/40 mt-2 space-y-1 rounded-md p-2">
      {rows.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between gap-2 px-1 py-1 text-xs"
        >
          <span className="text-muted-foreground tabular-nums">
            {formatDateTime(s.measuredAt)}
          </span>
          <span className="font-medium tabular-nums">
            {s.value} {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

function SortableHead({
  column,
  label,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  column: string;
  label: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  onSort: (col: string) => void;
  className?: string;
}) {
  const isActive = currentSort === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function DeleteButton({
  onConfirm,
  className = "size-11",
}: {
  onConfirm: () => void;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`text-destructive ${className}`}
          aria-label={t("common.delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("measurements.deleteConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("measurements.deleteConfirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
