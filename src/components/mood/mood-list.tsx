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
import { DateTimeInput } from "@/components/ui/date-input";
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
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  MoreHorizontal,
} from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  MOOD_LABEL_KEYS,
  MOOD_SCORE_BY_ENUM,
} from "@/lib/mood/labels";
import { invalidateKeys, moodDependentKeys } from "@/lib/query-keys";

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
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("moodLoggedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [editing, setEditing] = useState<MoodEntry | null>(null);
  const [editMood, setEditMood] = useState("");
  const [editTagsInput, setEditTagsInput] = useState("");
  const [editMoodLoggedAt, setEditMoodLoggedAt] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // v1.4.27 R4 RC2 — Sheet-branch sticky-pinned footer slot.
  const editFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  const setMoodFilter = (value: string) => {
    setMoodFilterRaw(value);
    setPage(1);
  };

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir(column === "moodLoggedAt" ? "desc" : "asc");
    }
    setPage(1);
  }

  const { data, isLoading } = useQuery({
    queryKey: [
      "mood-entries",
      moodFilter === "ALL" ? undefined : moodFilter,
      page,
      sortBy,
      sortDir,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (moodFilter !== "ALL") params.set("mood", moodFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const res = await fetch(`/api/mood-entries?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        entries: MoodEntry[];
        meta: { total: number };
      };
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/mood-entries/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, moodDependentKeys);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      mood,
      tags,
      moodLoggedAt,
    }: {
      id: string;
      mood: string;
      tags: string[] | null;
      moodLoggedAt: string;
    }) => {
      const res = await fetch(`/api/mood-entries/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mood, tags, moodLoggedAt }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Update failed");
      }
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, moodDependentKeys);
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => {
      setEditError(err instanceof Error ? err.message : t("mood.saveError"));
    },
  });

  const totalPages = data ? Math.ceil(data.meta.total / PAGE_SIZE) : 0;

  function startEdit(entry: MoodEntry) {
    setEditing(entry);
    setEditMood(entry.mood);
    setEditTagsInput(entry.tags.join(", "));
    setEditMoodLoggedAt(toDateTimeLocalValue(entry.moodLoggedAt));
    setEditError(null);
  }

  function closeEdit() {
    if (updateMutation.isPending || deleteMutation.isPending) return;
    setEditing(null);
    setEditError(null);
    setEditDeleteDialogOpen(false);
  }

  async function deleteEditingEntry() {
    if (!editing) return;

    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      closeEdit();
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

    setEditError(null);
    updateMutation.mutate({
      id: editing.id,
      mood: editMood,
      tags: tags.length > 0 ? tags : null,
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
        <div className="flex items-center justify-between">
          <Select value={moodFilter} onValueChange={setMoodFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder={t("mood.allMoods")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("mood.allMoods")}</SelectItem>
              {MOOD_LEVELS_LIST.map((val) => (
                <SelectItem key={val} value={val}>
                  {MOOD_SCORES[val]} ({t(MOOD_LABEL_KEYS[val])})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {data?.meta?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {t("mood.entryCount", {
                count: fmt.integer(data.meta.total),
              })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
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
                  <Plus className="mr-1 h-4 w-4" />
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
                    <SortableHead
                      column="mood"
                      label={t("mood.moodLevel")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-36 pl-4"
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
                  {data.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="pl-4 font-semibold tabular-nums">
                        {entry.score}{" "}
                        <span className="text-muted-foreground font-normal">
                          (
                          {MOOD_LABEL_KEYS[entry.mood]
                            ? t(MOOD_LABEL_KEYS[entry.mood])
                            : entry.mood}
                          )
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {entry.tags.length > 0 ? entry.tags.join(", ") : "-"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDateTime(entry.moodLoggedAt)}
                      </TableCell>
                      <TableCell>
                        {entry.source !== "MANUAL" && (
                          <Badge variant="outline" className="text-xs">
                            {t("mood.sourceMoodlog")}
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
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
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
              {data.entries.map((entry) => (
                <div
                  key={entry.id}
                  data-testid="mood-row"
                  className="bg-card border-border flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-2.5 overflow-hidden">
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
                      mobile
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

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
              <Button
                variant="ghost"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
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
            <form
              id={editFormId}
              onSubmit={submitEdit}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label id="edit-mood-level-label">{t("mood.moodLevel")}</Label>
                <div
                  role="radiogroup"
                  aria-labelledby="edit-mood-level-label"
                  className="grid grid-cols-5 gap-2"
                >
                  {MOOD_LEVELS_LIST.map((level) => {
                    const isSelected = editMood === level;
                    return (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setEditMood(level)}
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
                <Label htmlFor="edit-mood-logged-at">
                  {t("mood.timestamp")}
                </Label>
                <DateTimeInput
                  id="edit-mood-logged-at"
                  value={editMoodLoggedAt}
                  onChange={(e) => setEditMoodLoggedAt(e.target.value)}
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
                            className="h-9 w-9"
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
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
    </>
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
  mobile = false,
}: {
  onConfirm: () => void;
  mobile?: boolean;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={
            mobile
              ? "text-destructive min-h-11 min-w-11"
              : "text-destructive h-8 w-8"
          }
          aria-label={t("common.delete")}
        >
          <Trash2 className={mobile ? "h-4 w-4" : "h-3.5 w-3.5"} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("mood.deleteConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("mood.deleteConfirmDescription")}
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
