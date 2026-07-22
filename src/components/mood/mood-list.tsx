"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FilterBar,
  FilterBarDateRange,
  FilterBarSelect,
} from "@/components/ui/filter-bar";
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
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  SeededFormDiscardDialog,
  useSeededFormDismissal,
} from "@/components/forms/use-seeded-form-dismissal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DateTimeField } from "@/components/ui/date-time-field";
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
  Loader2,
  Pencil,
  Plus,
  Smile,
  Trash2,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTableSort } from "@/hooks/use-table-sort";

// Columns that open descending when first selected. The logged-at column
// reads newest-first by default; every other column opens ascending.
const MOOD_DESC_COLUMNS: ReadonlySet<string> = new Set(["moodLoggedAt"]);
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { MOOD_LABEL_KEYS, MOOD_SCORE_BY_ENUM } from "@/lib/mood/labels";
import {
  invalidateKeys,
  moodDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { moodSourceEnum } from "@/lib/validations/moodlog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SortableHead,
  DeleteButton,
  SelectionActionBar,
  toggleId,
  toggleSelectAll,
  selectAllState,
  selectedIdsOnPage,
  selectedCountOnPage,
} from "@/components/data-list";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { MoodTagPicker, type RatedFactor } from "./mood-tag-picker";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";

// Re-export the score map under the legacy local name to keep the
// rest of this file unchanged. v1.4.27 B6 / BL-P6-11 — the single
// source of truth now lives in `@/lib/mood/labels`.
const MOOD_SCORES = MOOD_SCORE_BY_ENUM as Record<string, number>;

interface MoodEntry {
  id: string;
  date: string;
  mood: string;
  score: number;
  tags: string[];
  // v1.8.5 — structured-tag keys + free-text note.
  tagKeys: string[];
  ratedFactors: RatedFactor[];
  note: string | null;
  source: string;
  moodLoggedAt: string;
}

const PAGE_SIZE = 25;

const MOOD_LEVELS_LIST = [
  "SUPER_GUT",
  "GUT",
  "OKAY",
  "SCHLECHT",
  "LAUSIG",
] as const;

function toDateTimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

interface MoodListProps {
  /**
   * v1.4.15 phase-C5: optional callback wired by the parent page so
   * the empty-state's "Log your first mood" CTA opens the same dialog
   * the header button does. When undefined, the CTA hides instead of
   * rendering a no-op button.
   */
  onAddFirst?: () => void;
}

export function MoodList({ onAddFirst }: MoodListProps = {}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [moodFilter, setMoodFilterRaw] = useState<string>("ALL");
  // v1.15.13 — management-list source filter + optional date range.
  const [sourceFilter, setSourceFilterRaw] = useState<string>("ALL");
  const [fromDay, setFromDayRaw] = useState<string>("");
  const [toDay, setToDayRaw] = useState<string>("");
  const [page, setPage] = useState(1);
  // Shared column-sort state (moodLoggedAt opens descending).
  const {
    sortBy,
    sortDir,
    toggleSort: applySort,
  } = useTableSort({
    defaultColumn: "moodLoggedAt",
    defaultDir: "desc",
    descColumns: MOOD_DESC_COLUMNS,
  });

  // v1.15.13 — page-scoped multi-select selection (current page ids only).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // v1.16.8 — per-entry note expansion. Notes were readable in full only
  // through the edit sheet (desktop hover tooltip aside); the row now
  // toggles between the clamped preview and the complete text.
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleNote = (id: string) =>
    setExpandedNoteIds((prev) => toggleId(prev, id));

  const [editing, setEditing] = useState<MoodEntry | null>(null);
  const [editMood, setEditMood] = useState("");
  const { getRadioProps: getEditMoodRadioProps } = useRovingRadioGroup({
    count: MOOD_LEVELS_LIST.length,
    selectedIndex: MOOD_LEVELS_LIST.indexOf(
      editMood as (typeof MOOD_LEVELS_LIST)[number],
    ),
    onSelect: (index) => setEditMood(MOOD_LEVELS_LIST[index]!),
  });
  const [editTagsInput, setEditTagsInput] = useState("");
  const [editTagKeys, setEditTagKeys] = useState<string[]>([]);
  const [editRatedFactors, setEditRatedFactors] = useState<RatedFactor[]>([]);
  const [editNote, setEditNote] = useState("");
  const [editMoodLoggedAt, setEditMoodLoggedAt] = useState("");
  const [editSeed, setEditSeed] = useState<{
    mood: string;
    tagsInput: string;
    tagKeys: string[];
    ratedFactors: RatedFactor[];
    note: string;
    moodLoggedAt: string;
  }>({
    mood: "",
    tagsInput: "",
    tagKeys: [],
    ratedFactors: [],
    note: "",
    moodLoggedAt: "",
  });
  const [editError, setEditError] = useState<string | null>(null);

  function toggleEditTagKey(key: string) {
    setEditTagKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  function rateEditFactor(key: string, rating: number | null) {
    setEditRatedFactors((prev) => {
      const rest = prev.filter((factor) => factor.key !== key);
      return rating === null ? rest : [...rest, { key, rating }];
    });
  }
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // v1.4.27 R4 RC2 — Sheet-branch sticky-pinned footer slot.
  const editFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);

  // v1.15.13 — every filter / page / sort change resets pagination AND
  // clears the page-scoped selection.
  const clearSelection = () => setSelectedIds(new Set());

  const setMoodFilter = (value: string) => {
    setMoodFilterRaw(value);
    setPage(1);
    clearSelection();
  };

  const setSourceFilter = (value: string) => {
    setSourceFilterRaw(value);
    setPage(1);
    clearSelection();
  };

  const setFromDay = (value: string) => {
    setFromDayRaw(value);
    setPage(1);
    clearSelection();
  };

  const setToDay = (value: string) => {
    setToDayRaw(value);
    setPage(1);
    clearSelection();
  };

  const goToPage = (updater: (p: number) => number) => {
    setPage(updater);
    clearSelection();
  };

  // Compose the page-reset + selection-clear side effects around the
  // shared sort toggle.
  function toggleSort(column: string) {
    applySort(column);
    setPage(1);
    clearSelection();
  }

  // v1.15.13 — mood list `from`/`to` are YYYY-MM-DD (the date inputs hand
  // back exactly that), so they pass through unchanged. `ALL` clears the
  // source filter.
  const fromParam = fromDay || undefined;
  const toParam = toDay || undefined;
  const sourceParam = sourceFilter === "ALL" ? undefined : sourceFilter;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.moodEntriesList({
      mood: moodFilter === "ALL" ? undefined : moodFilter,
      source: sourceParam,
      from: fromParam,
      to: toParam,
      page,
      sortBy,
      sortDir,
    }),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (moodFilter !== "ALL") params.set("mood", moodFilter);
      if (sourceParam) params.set("source", sourceParam);
      if (fromParam) params.set("from", fromParam);
      if (toParam) params.set("to", toParam);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      return apiGet<{
        entries: MoodEntry[];
        meta: { total: number };
      }>(`/api/mood-entries?${params}`);
    },
    enabled: isAuthenticated,
  });

  // v1.16.4 — deletes are soft (tombstones), so the success toast can
  // carry a real Undo: it POSTs the ids to `/api/mood-entries/restore`,
  // which clears `deletedAt` and re-fires the same dependent-key bundle.
  // Mirrors the measurements list and the intake-Undo pattern.
  const restoreEntries = useCallback(
    async (ids: string[]) => {
      try {
        await apiPost("/api/mood-entries/restore", { ids });
        await invalidateKeys(queryClient, moodDependentKeys);
        await refetchInactiveDailyReads(queryClient);
        toast.success(t("mood.restoredToast"));
      } catch {
        toast.error(t("mood.restoreError"));
      }
    },
    [queryClient, t],
  );

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/mood-entries/${id}`);
    },
    onSuccess: (_data, id) => {
      void invalidateKeys(queryClient, moodDependentKeys);
      void refetchInactiveDailyReads(queryClient);
      toast.success(t("mood.deletedToast"), {
        action: {
          label: t("common.undo"),
          onClick: () => void restoreEntries([id]),
        },
      });
    },
    // v1.11.5 — a failed delete used to fail silently (no onError handler),
    // leaving the row in place with no signal that the request was rejected.
    // Surface the failure so the user knows to retry. Mirrors the v1.11.3
    // medication-card silent-failure fix.
    onError: () => {
      toast.error(t("mood.deleteError"));
    },
  });

  // v1.15.13 — page-scoped bulk soft-delete, mirroring the measurements list.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const data = await apiPost<{ deleted: number }>(
        "/api/mood-entries/bulk-delete",
        { ids },
      );
      return data.deleted;
    },
    onSuccess: async (deleted, ids) => {
      await invalidateKeys(queryClient, moodDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      clearSelection();
      toast.success(t("mood.bulkDeleteSuccess", { count: String(deleted) }), {
        action: {
          label: t("common.undo"),
          onClick: () => void restoreEntries(ids),
        },
      });
    },
    onError: () => {
      toast.error(t("mood.bulkDeleteError"));
    },
  });

  const pageIds = (data?.entries ?? []).map((e) => e.id);

  // Selection reads intersect with the painted page, so a stale id never
  // counts; page / filter / sort changes clear selection. No prune effect.
  const selectAll = selectAllState(selectedIds, pageIds);
  const selectedOnPage = selectedCountOnPage(selectedIds, pageIds);

  function onToggleRow(id: string) {
    setSelectedIds((prev) => toggleId(prev, id));
  }

  function onToggleSelectAll() {
    setSelectedIds((prev) => toggleSelectAll(prev, pageIds));
  }

  function onConfirmBulkDelete() {
    const ids = selectedIdsOnPage(selectedIds, pageIds);
    if (ids.length === 0) return;
    bulkDeleteMutation.mutate(ids);
  }

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      mood,
      tags,
      tagKeys,
      ratedFactors,
      note,
      moodLoggedAt,
    }: {
      id: string;
      mood: string;
      tags: string[] | null;
      tagKeys: string[];
      ratedFactors: RatedFactor[];
      note: string | null;
      moodLoggedAt: string;
    }) => {
      await apiPut(`/api/mood-entries/${id}`, {
        mood,
        tags,
        tagKeys,
        ratedFactors,
        note,
        moodLoggedAt,
      });
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, moodDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      setEditSeed({
        mood: editMood,
        tagsInput: editTagsInput,
        tagKeys: [...editTagKeys].sort(),
        ratedFactors: [...editRatedFactors].sort((a, b) =>
          a.key.localeCompare(b.key),
        ),
        note: editNote,
        moodLoggedAt: editMoodLoggedAt,
      });
      dismissEdit();
    },
    onError: (err) => {
      setEditError(localizedApiError(err, t, "mood.saveError"));
    },
  });
  const editDismissal = useSeededFormDismissal({
    seed: editSeed,
    value: {
      mood: editMood,
      tagsInput: editTagsInput,
      tagKeys: [...editTagKeys].sort(),
      ratedFactors: [...editRatedFactors].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      note: editNote,
      moodLoggedAt: editMoodLoggedAt,
    },
    blocked: updateMutation.isPending || deleteMutation.isPending,
  });

  const totalPages = data ? Math.ceil(data.meta.total / PAGE_SIZE) : 0;

  function startEdit(entry: MoodEntry) {
    const seed = {
      mood: entry.mood,
      tagsInput: entry.tags.join(", "),
      tagKeys: [...(entry.tagKeys ?? [])].sort(),
      ratedFactors: [...(entry.ratedFactors ?? [])].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      note: entry.note ?? "",
      moodLoggedAt: toDateTimeLocalValue(entry.moodLoggedAt),
    };
    setEditing(entry);
    setEditMood(seed.mood);
    setEditTagsInput(seed.tagsInput);
    setEditTagKeys(seed.tagKeys);
    setEditRatedFactors(seed.ratedFactors);
    setEditNote(seed.note);
    setEditMoodLoggedAt(seed.moodLoggedAt);
    setEditSeed(seed);
    setEditError(null);
  }

  function dismissEdit() {
    setEditing(null);
    setEditError(null);
    setEditDeleteDialogOpen(false);
  }

  function closeEdit() {
    editDismissal.requestClose(dismissEdit);
  }

  async function deleteEditingEntry() {
    if (!editing) return;

    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      dismissEdit();
    } catch {
      setEditError(t("mood.deleteError"));
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || !editMood) return;

    const measuredDate = new Date(editMoodLoggedAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("mood.invalidTimestamp"));
      return;
    }

    const tags = editTagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const trimmedNote = editNote.trim();

    setEditError(null);
    updateMutation.mutate({
      id: editing.id,
      mood: editMood,
      tags: tags.length > 0 ? tags : null,
      tagKeys: editTagKeys,
      ratedFactors: editRatedFactors,
      note: trimmedNote.length > 0 ? trimmedNote : null,
      moodLoggedAt: measuredDate.toISOString(),
    });
  }

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">{t("mood.loginRequired")}</p>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {/* v1.16.1 — unified filter rail (`<FilterBar>`), same grammar as
            the measurements list: date range · mood · source as compact
            pills, active filters as removable chips, reset + count.
            Filter state and query keys unchanged. */}
        <FilterBar
          isFiltered={
            moodFilter !== "ALL" ||
            sourceFilter !== "ALL" ||
            fromDay !== "" ||
            toDay !== ""
          }
          onReset={() => {
            setMoodFilter("ALL");
            setSourceFilter("ALL");
            setFromDay("");
            setToDay("");
          }}
          count={
            data?.meta?.total !== undefined
              ? t("mood.entryCount", {
                  count: fmt.integer(data.meta.total),
                })
              : undefined
          }
        >
          <FilterBarDateRange
            label={t("dataList.dateRange")}
            from={fromDay}
            to={toDay}
            onFromChange={setFromDay}
            onToChange={setToDay}
            idPrefix="mood"
          />
          <FilterBarSelect
            label={t("mood.moodLevel")}
            value={moodFilter}
            onValueChange={setMoodFilter}
            allLabel={t("mood.allMoods")}
            options={MOOD_LEVELS_LIST.map((val) => ({
              value: val,
              label: `${MOOD_SCORES[val]} (${t(MOOD_LABEL_KEYS[val])})`,
            }))}
          />
          <FilterBarSelect
            label={t("dataList.sourceLabel")}
            value={sourceFilter}
            onValueChange={setSourceFilter}
            allLabel={t("dataList.allSources")}
            options={MOOD_SOURCE_OPTIONS.map((src) => ({
              value: src,
              label: formatMoodSource(src, t),
            }))}
          />
        </FilterBar>

        {isLoading ? (
          <div className="space-y-2" data-slot="mood-list-loading">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          // A read failure is NOT an empty list — surface the error + Retry so
          // an outage never reads as "you have no mood entries".
          <QueryErrorCard
            title={t("mood.loadError")}
            onRetry={() => void refetch()}
          />
        ) : !data?.entries?.length ? (
          // v1.4.15 phase-C5: replace bare-text empty rectangle with
          // EmptyState. Filter-aware copy splits "no mood entries yet"
          // (brand-new account) from "no entries match this filter".
          <EmptyState
            icon={<Smile className="size-6" />}
            title={
              moodFilter === "ALL"
                ? t("mood.emptyTitle")
                : t("mood.emptyFilteredTitle")
            }
            description={
              moodFilter === "ALL"
                ? t("mood.emptyDescription")
                : t("mood.emptyFilteredDescription")
            }
            action={
              moodFilter !== "ALL" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMoodFilter("ALL")}
                >
                  {t("mood.emptyResetFilter")}
                </Button>
              ) : onAddFirst ? (
                <Button size="sm" onClick={onAddFirst}>
                  <Plus className="h-4 w-4" />
                  {t("mood.emptyAddFirst")}
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
                    <TableHead className="w-10 pl-4">
                      {/* v1.15.13 — select-all-on-page header checkbox. */}
                      <Checkbox
                        checked={
                          selectAll === "all"
                            ? true
                            : selectAll === "some"
                              ? "indeterminate"
                              : false
                        }
                        disabled={pageIds.length === 0}
                        onCheckedChange={onToggleSelectAll}
                        aria-label={t("dataList.selectAll")}
                      />
                    </TableHead>
                    <SortableHead
                      column="mood"
                      label={t("mood.moodLevel")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-36"
                    />
                    <TableHead>{t("mood.tags")}</TableHead>
                    <SortableHead
                      column="moodLoggedAt"
                      label={t("mood.date")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      column="source"
                      label={t("mood.source")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-20"
                    />
                    <TableHead className="w-20 pr-4 text-right">
                      {t("mood.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((entry) => {
                    const isSelected = selectedIds.has(entry.id);
                    return (
                      <TableRow
                        key={entry.id}
                        data-state={isSelected ? "selected" : undefined}
                      >
                        <TableCell className="pl-4">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => onToggleRow(entry.id)}
                            aria-label={t("dataList.selectRow")}
                          />
                        </TableCell>
                        <TableCell className="font-semibold tabular-nums">
                          {entry.score}{" "}
                          <span className="text-muted-foreground font-normal">
                            (
                            {MOOD_LABEL_KEYS[entry.mood]
                              ? t(MOOD_LABEL_KEYS[entry.mood])
                              : entry.mood}
                            )
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[18rem] text-sm">
                          <span className="block truncate">
                            {entry.tags.length > 0
                              ? entry.tags.join(", ")
                              : "-"}
                          </span>
                          {entry.note && (
                            <MoodNoteText
                              note={entry.note}
                              expanded={expandedNoteIds.has(entry.id)}
                              onToggle={() => toggleNote(entry.id)}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDateTime(entry.moodLoggedAt)}
                        </TableCell>
                        <TableCell>
                          {entry.source !== "MANUAL" && (
                            <Badge variant="outline" className="text-xs">
                              {formatMoodSource(entry.source, t)}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => startEdit(entry)}
                              aria-label={t("common.edit")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <DeleteButton
                              onConfirm={() => deleteMutation.mutate(entry.id)}
                              title={t("mood.deleteConfirmTitle")}
                              description={t("mood.deleteConfirmDescription")}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Mobile list — v1.4.15 phase-A3 fix #2: previously the row
                rendered the score TWICE on mobile (the big number in the
                left badge AND a duplicate in the title line: "2 (schlecht)").
                Desktop's table version only ever showed one. The badge is
                the visual anchor; next to it the user wants the textual
                label, not a second copy of the digit. The
                `data-testid="mood-row"` hook is what the Playwright Pixel-5
                guard at `e2e/mood-card-mobile.spec.ts` queries to assert
                "exactly one occurrence of the score per row". */}
            <div className="space-y-2 md:hidden">
              {data.entries.map((entry) => {
                const isSelected = selectedIds.has(entry.id);
                return (
                  <div
                    key={entry.id}
                    data-testid="mood-row"
                    data-state={isSelected ? "selected" : undefined}
                    className="bg-card border-border data-[state=selected]:border-primary/60 data-[state=selected]:bg-primary/5 flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      {/* v1.15.13 MEDIUM-1 kept the 16px Radix Checkbox
                        (itself a `<button role=checkbox>`) inside a 44px
                        wrapper `<button>` for WCAG 2.5.5 — but a button may
                        not nest inside a button, and the invalid markup made
                        React 19 fail hydration on every list paint. The
                        wrapper is now a plain layout `<div>`; the Checkbox
                        stays the single control and owns the 44px hit area
                        via an `after` hit-slop (clicks on a pseudo-element
                        hit-test against its host button). */}
                      <div className="flex size-11 shrink-0 items-center justify-center">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => onToggleRow(entry.id)}
                          aria-label={t("dataList.selectRow")}
                          className="relative after:absolute after:-inset-3.5"
                        />
                      </div>
                      <div className="bg-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
                        <span
                          data-testid="mood-row-score"
                          className="text-lg font-bold tabular-nums"
                        >
                          {entry.score}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-semibold">
                          {MOOD_LABEL_KEYS[entry.mood]
                            ? t(MOOD_LABEL_KEYS[entry.mood])
                            : entry.mood}
                        </span>
                        <p className="text-muted-foreground truncate text-xs">
                          {formatDateTime(entry.moodLoggedAt)}
                        </p>
                        {entry.tags.length > 0 && (
                          <p className="text-muted-foreground truncate text-xs">
                            {entry.tags.join(", ")}
                          </p>
                        )}
                        {entry.note && (
                          <MoodNoteText
                            note={entry.note}
                            expanded={expandedNoteIds.has(entry.id)}
                            onToggle={() => toggleNote(entry.id)}
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Phase A5 mobile audit: bumped from h-8 w-8 (32px)
                        to min-h-11 min-w-11 (44px) so the per-row edit
                        and delete actions meet WCAG 2.5.5 on touch
                        devices. The desktop table keeps its denser
                        h-8 w-8 since pointer targets allow it. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        onClick={() => startEdit(entry)}
                        aria-label={t("common.edit")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <DeleteButton
                        onConfirm={() => deleteMutation.mutate(entry.id)}
                        iconClassName="h-4 w-4"
                        title={t("mood.deleteConfirmTitle")}
                        description={t("mood.deleteConfirmDescription")}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* v1.15.13 — page-scoped multi-select action bar. */}
        <SelectionActionBar
          count={selectedOnPage}
          onClear={clearSelection}
          onConfirmDelete={onConfirmBulkDelete}
          isDeleting={bulkDeleteMutation.isPending}
          confirmTitle={t("mood.bulkDeleteConfirmTitle", {
            count: String(selectedOnPage),
          })}
          confirmBody={t("mood.bulkDeleteConfirmBody", {
            count: String(selectedOnPage),
          })}
        />

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {t("mood.pageInfo", {
                page: String(page),
                total: String(totalPages),
              })}
            </span>
            <div className="flex gap-1">
              {/* v1.15.13 L2 — match the measurements list's 44px pagination
                  target (was `size="sm"`, below the WCAG 2.5.5 floor). */}
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page <= 1}
                onClick={() => goToPage((p) => p - 1)}
                aria-label={t("mood.previousPage")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page >= totalPages}
                onClick={() => goToPage((p) => p + 1)}
                aria-label={t("mood.nextPage")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Edit sheet — bottom-sheet on `<md`, centred Dialog on `md+`. */}
      <ResponsiveSheet
        open={!!editing}
        onOpenChange={(open) => !open && closeEdit()}
        title={t("mood.editEntry")}
        footer={<div ref={setEditFooterEl} className="flex w-full" />}
      >
        {editing && (
          <form id={editFormId} onSubmit={submitEdit} className="space-y-4">
            <div className="space-y-2">
              <Label id="edit-mood-level-label">{t("mood.moodLevel")}</Label>
              <div
                role="radiogroup"
                aria-labelledby="edit-mood-level-label"
                className="grid grid-cols-5 gap-2"
              >
                {MOOD_LEVELS_LIST.map((level, index) => {
                  const isSelected = editMood === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setEditMood(level)}
                      {...getEditMoodRadioProps(index)}
                      className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-center transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/10 text-primary border-2"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <span className="text-lg font-semibold tabular-nums">
                        {MOOD_SCORES[level]}
                      </span>
                      <span className="text-[10px] leading-tight sm:text-xs">
                        {t(MOOD_LABEL_KEYS[level])}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-mood-logged-at">{t("mood.timestamp")}</Label>
              <DateTimeField
                id="edit-mood-logged-at"
                value={editMoodLoggedAt}
                onChange={setEditMoodLoggedAt}
                // v1.17 W1b — match the server bound: no future instant.
                max={toDateTimeLocalValue(new Date().toISOString())}
                required
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="edit-tags">
                  {t("mood.tags")} ({t("common.optional")})
                </Label>
                <span className="text-muted-foreground text-xs">
                  {t("mood.tagsHelp")}
                </span>
              </div>
              <Input
                id="edit-tags"
                value={editTagsInput}
                onChange={(e) => setEditTagsInput(e.target.value)}
                placeholder={t("mood.tagsPlaceholder")}
              />
            </div>

            {/* v1.8.5 — structured-tag taxonomy picker. */}
            <div className="space-y-2">
              <Label>
                {t("mood.tagPicker")} ({t("common.optional")})
              </Label>
              <MoodTagPicker
                selected={editTagKeys}
                onToggle={toggleEditTagKey}
                ratedFactors={editRatedFactors}
                onRateFactor={rateEditFactor}
              />
            </div>

            {/* v1.8.5 (C1) — free-text note. */}
            <div className="space-y-2">
              <Label htmlFor="edit-mood-note">
                {t("mood.note")} ({t("common.optional")})
              </Label>
              <Textarea
                id="edit-mood-note"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder={t("mood.notePlaceholder")}
                maxLength={500}
                rows={3}
              />
            </div>

            {editError && (
              <div
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
                          className="h-11 w-11"
                          disabled={
                            updateMutation.isPending || deleteMutation.isPending
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
                          updateMutation.isPending || deleteMutation.isPending
                        }
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="submit"
                        form={editFormId}
                        disabled={
                          updateMutation.isPending || deleteMutation.isPending
                        }
                      >
                        {updateMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
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
                    {t("mood.deleteConfirmTitle")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("mood.deleteConfirmDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>
                    {t("common.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={deleteEditingEntry}
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
      <SeededFormDiscardDialog
        open={editDismissal.discardDialogOpen}
        onConfirm={editDismissal.confirmDiscard}
        onCancel={editDismissal.cancelDiscard}
      />
    </>
  );
}

/**
 * v1.16.8 — expandable free-text note. Collapsed: a two-line clamped
 * preview. Expanded: the COMPLETE text, line breaks preserved, rendered as
 * plain text children. The full note is readable in place — previously the
 * only full-text surface was the edit sheet (plus a hover tooltip on
 * desktop, unreachable on touch).
 *
 * Structure: the note is a plain paragraph with an `id`; the toggle is a
 * SMALL sibling button carrying `aria-expanded` + `aria-controls`. The
 * earlier cut wrapped the whole paragraph in the button, which made the
 * entire note text the button's accessible name and put block content
 * inside a button (invalid content model).
 *
 * The toggle only renders when the collapsed paragraph actually
 * overflows its two-line clamp (`scrollHeight > clientHeight`, re-checked
 * on resize) — a one-line note gets no dangling "show more" control.
 */
function MoodNoteText({
  note,
  expanded,
  onToggle,
}: {
  note: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslations();
  const noteId = useId();
  const paragraphRef = useRef<HTMLParagraphElement | null>(null);
  const [clamped, setClamped] = useState(false);

  const updateClamped = useCallback(() => {
    const el = paragraphRef.current;
    if (!el) return;
    // +1 tolerates sub-pixel rounding on fractional zoom levels.
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => {
    // Only the collapsed paragraph carries the clamp; measuring the
    // expanded one would always read "fits" and drop the collapse
    // affordance while it is needed most.
    if (expanded) return;
    updateClamped();
    const el = paragraphRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateClamped);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, note, updateClamped]);

  return (
    <div className="mt-0.5 min-w-0">
      <p
        id={noteId}
        ref={paragraphRef}
        data-testid="mood-note-text"
        className={
          // User-authored content renders in foreground — user data is never
          // muted (the row's timestamp stays muted); italic keeps the note
          // visually distinct from app copy.
          expanded
            ? "text-foreground text-sm break-words whitespace-pre-wrap italic"
            : "text-foreground line-clamp-2 text-sm italic"
        }
      >
        {note}
      </p>
      {(expanded || clamped) && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={noteId}
          data-testid="mood-note-toggle"
          className="text-primary cursor-pointer text-xs font-medium"
        >
          {expanded ? t("mood.noteCollapse") : t("mood.noteExpand")}
        </button>
      )}
    </div>
  );
}

/**
 * v1.15.13 — render a `MoodEntry.source` value with its localized label.
 * MANUAL is shown via the source filter only (a manual row carries no
 * badge in the table). MOODLOG keeps its existing `mood.sourceMoodlog`
 * key; the rest fall back to their own keys.
 */
function formatMoodSource(
  source: string,
  t: ReturnType<typeof useTranslations>["t"],
): string {
  switch (source) {
    case "MANUAL":
      return t("mood.sourceManual");
    case "MOODLOG":
      return t("mood.sourceMoodlog");
    case "WEB":
      return t("mood.sourceWeb");
    case "TELEGRAM":
      return t("mood.sourceTelegram");
    case "DAYLIO":
      return t("mood.sourceDaylio");
    default:
      return source;
  }
}

/** v1.15.13 — mood source enum values offered in the source filter. */
const MOOD_SOURCE_OPTIONS = moodSourceEnum.options;
