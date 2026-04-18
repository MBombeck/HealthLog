"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Loader2,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  MoreHorizontal,
  Scale,
  Heart,
  Activity,
  Droplets,
  Moon,
  Footprints,
} from "lucide-react";
import { useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";

const TYPE_LABEL_KEYS: Record<string, string> = {
  WEIGHT: "measurements.typeWeight",
  BLOOD_PRESSURE_SYS: "measurements.typeBpSys",
  BLOOD_PRESSURE_DIA: "measurements.typeBpDia",
  PULSE: "measurements.typePulse",
  BODY_FAT: "measurements.typeBodyFat",
  SLEEP_DURATION: "measurements.typeSleep",
  ACTIVITY_STEPS: "measurements.typeSteps",
};

const TYPE_ICONS: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  WEIGHT: Scale,
  BLOOD_PRESSURE_SYS: Heart,
  BLOOD_PRESSURE_DIA: Heart,
  PULSE: Activity,
  BODY_FAT: Droplets,
  SLEEP_DURATION: Moon,
  ACTIVITY_STEPS: Footprints,
};

const TYPE_COLORS: Record<string, string> = {
  WEIGHT: "bg-chart-1/20 text-chart-1",
  BLOOD_PRESSURE_SYS: "bg-chart-3/20 text-chart-3",
  BLOOD_PRESSURE_DIA: "bg-chart-3/20 text-chart-3",
  PULSE: "bg-chart-5/20 text-chart-5",
  BODY_FAT: "bg-chart-4/20 text-chart-4",
  SLEEP_DURATION: "bg-chart-2/20 text-chart-2",
  ACTIVITY_STEPS: "bg-chart-2/20 text-chart-2",
};

interface Measurement {
  id: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  measuredAt: string;
  notes: string | null;
}

interface MeasurementListProps {
  onEdit?: (m: Measurement) => void;
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

export function MeasurementList({ onEdit }: MeasurementListProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilterRaw] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("measuredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [editing, setEditing] = useState<Measurement | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editMeasuredAt, setEditMeasuredAt] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);

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

  const { data, isLoading } = useQuery({
    queryKey: [
      "measurements",
      typeFilter === "ALL" ? undefined : typeFilter,
      page,
      sortBy,
      sortDir,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter !== "ALL") params.set("type", typeFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
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

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Update failed");
      }
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, measurementDependentKeys);
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => {
      setEditError(
        err instanceof Error ? err.message : t("measurements.saveError"),
      );
    },
  });

  const totalPages = data ? Math.ceil(data.meta.total / PAGE_SIZE) : 0;

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
        <div className="flex items-center justify-between">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-48">
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
          {data?.meta.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {t("measurements.measurementCount", {
                count: fmt.integer(data.meta.total),
              })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin" />
          </div>
        ) : !data?.measurements.length ? (
          <div className="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed">
            {t("measurements.noMeasurements")}
          </div>
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
                  {data.measurements.map((m) => (
                    <TableRow key={m.id}>
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
                        {m.value} {m.unit}
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
                          <Badge variant="outline" className="text-xs">
                            {m.source}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => startEdit(m)}
                            aria-label={t("common.edit")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <DeleteButton
                            onConfirm={() => deleteMutation.mutate(m.id)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile list */}
            <div className="space-y-2 md:hidden">
              {data.measurements.map((m) => {
                const Icon = TYPE_ICONS[m.type];
                return (
                  <div
                    key={m.id}
                    className="bg-card border-border flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2.5 overflow-hidden">
                      {Icon && (
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TYPE_COLORS[m.type] ?? ""}`}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="font-semibold tabular-nums">
                          {m.value} {m.unit}
                        </span>
                        <p className="text-muted-foreground truncate text-xs">
                          {formatDateTime(m.measuredAt)}
                        </p>
                        {m.notes && (
                          <p className="text-muted-foreground truncate text-xs">
                            {truncateComment(m.notes)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => startEdit(m)}
                        aria-label={t("common.edit")}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <DeleteButton
                        onConfirm={() => deleteMutation.mutate(m.id)}
                      />
                    </div>
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

      <Dialog open={!!editing} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("measurements.editMeasurement")}</DialogTitle>
          </DialogHeader>
          {editing && (
            <form onSubmit={submitEdit} className="space-y-4">
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
                  step="any"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-measuredAt">
                  {t("measurements.timestamp")}
                </Label>
                <Input
                  id="edit-measuredAt"
                  type="datetime-local"
                  value={editMeasuredAt}
                  onChange={(e) => setEditMeasuredAt(e.target.value)}
                  required
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
                />
              </div>

              {editError && (
                <div role="alert" aria-live="assertive" className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
                  {editError}
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-9 w-9"
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
                    disabled={
                      updateMutation.isPending || deleteMutation.isPending
                    }
                  >
                    {updateMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {t("common.save")}
                  </Button>
                </div>
              </div>

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
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : null}
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          )}
        </DialogContent>
      </Dialog>
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

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const { t } = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive h-8 w-8"
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
