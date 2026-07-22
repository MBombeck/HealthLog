"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";

import { DeleteButton, SortableHead } from "@/components/data-list";
import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/ui/date-time-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useTableSort } from "@/hooks/use-table-sort";
import { ApiError, apiDelete, apiPatch } from "@/lib/api/api-fetch";
import { formatDateShort } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { formatMetricValue } from "./format-value";
import type { CustomMetricEntryDto } from "./types";

const NOTE_MAX_LENGTH = 2000;

const DESC_COLUMNS = new Set(["measuredAt"]);

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
}

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * v1.25.5 — reverse-chronological value history for one custom metric, with
 * full edit + delete. An edit overwrites in place; delete hard-deletes (the
 * value store has no soft-delete tier).
 */
export function CustomMetricHistoryList({
  customMetricId,
  entries,
  unit,
  decimals,
}: {
  customMetricId: string;
  entries: CustomMetricEntryDto[];
  unit: string;
  decimals: number | null;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { sortBy, sortDir, toggleSort } = useTableSort({
    defaultColumn: "measuredAt",
    defaultDir: "desc",
    descColumns: DESC_COLUMNS,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editMeasuredAt, setEditMeasuredAt] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.customMetrics() });
    queryClient.invalidateQueries({
      queryKey: queryKeys.customMetricDetail(customMetricId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.customMetricEntriesPrefix(customMetricId),
    });
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/custom-metrics/${customMetricId}/entries/${id}`),
    onSuccess: () => {
      invalidate();
      toast.success(t("customMetrics.entry.deletedToast"));
    },
    onError: () => toast.error(t("customMetrics.entry.deleteError")),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      id: string;
      value: number;
      measuredAt: string;
      note: string | null;
    }) =>
      apiPatch<CustomMetricEntryDto>(
        `/api/custom-metrics/${customMetricId}/entries/${body.id}`,
        {
          value: body.value,
          measuredAt: body.measuredAt,
          note: body.note,
        },
      ),
    onSuccess: () => {
      invalidate();
      toast.success(t("customMetrics.entry.editedToast"));
      closeEdit();
    },
    onError: (err) => {
      setEditError(
        err instanceof ApiError
          ? err.message
          : t("customMetrics.entry.editError"),
      );
    },
  });

  function openEdit(entry: CustomMetricEntryDto) {
    setEditingId(entry.id);
    setEditValue(String(entry.value));
    setEditMeasuredAt(toDateTimeLocal(entry.measuredAt));
    setEditNote(entry.note ?? "");
    setEditError(null);
  }

  function closeEdit() {
    if (updateMutation.isPending) return;
    setEditingId(null);
    setEditError(null);
  }

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const numeric = parseDecimal(editValue);
    if (numeric === null) {
      setEditError(t("customMetrics.entry.valueError"));
      return;
    }
    const measuredDate = new Date(editMeasuredAt);
    if (Number.isNaN(measuredDate.getTime())) {
      setEditError(t("customMetrics.entry.timestampError"));
      return;
    }
    updateMutation.mutate({
      id: editingId,
      value: numeric,
      measuredAt: measuredDate.toISOString(),
      note: editNote.trim() ? editNote.trim() : null,
    });
  }

  const ordered = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "value":
          cmp = a.value - b.value;
          break;
        case "note":
          cmp = Number(Boolean(a.note)) - Number(Boolean(b.note));
          break;
        case "measuredAt":
        default:
          cmp =
            new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime();
          break;
      }
      if (cmp === 0) {
        cmp =
          new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime();
      }
      return cmp * dir;
    });
  }, [entries, sortBy, sortDir]);

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead
              column="value"
              label={t("customMetrics.entry.value")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
            />
            <SortableHead
              column="measuredAt"
              label={t("customMetrics.entry.measuredAt")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
            />
            <SortableHead
              column="note"
              label={t("customMetrics.entry.note")}
              currentSort={sortBy}
              currentDir={sortDir}
              onSort={toggleSort}
            />
            <TableHead className="w-20 pr-4 text-right">
              <span className="sr-only">{t("customMetrics.entry.edit")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ordered.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-semibold tabular-nums">
                {formatMetricValue(r.value, decimals)}
                {unit ? ` ${unit}` : ""}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                {formatDateShort(r.measuredAt, true)}
              </TableCell>
              <TableCell className="text-muted-foreground max-w-[12rem] truncate text-sm">
                {r.note ?? ""}
              </TableCell>
              <TableCell className="pr-4 text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-11 sm:size-9"
                    onClick={() => openEdit(r)}
                    aria-label={t("customMetrics.entry.edit")}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <DeleteButton
                    onConfirm={() => deleteMutation.mutate(r.id)}
                    title={t("customMetrics.entry.deleteConfirmTitle")}
                    description={t(
                      "customMetrics.entry.deleteConfirmDescription",
                    )}
                    confirmLabel={t("customMetrics.entry.delete")}
                    className="size-11 sm:size-9"
                    iconClassName="h-4 w-4"
                  />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ResponsiveSheet
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
        title={t("customMetrics.entry.editTitle")}
        description={t("customMetrics.entry.editDescription")}
      >
        <form onSubmit={submitEdit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="custom-metric-edit-value">
                {t("customMetrics.entry.value")}
                {unit ? ` (${unit})` : ""}
              </Label>
              <Input
                id="custom-metric-edit-value"
                inputMode="decimal"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-metric-edit-measuredAt">
                {t("customMetrics.entry.measuredAt")}
              </Label>
              <DateTimeField
                id="custom-metric-edit-measuredAt"
                value={editMeasuredAt}
                onChange={setEditMeasuredAt}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-metric-edit-note">
              {t("customMetrics.entry.note")}
            </Label>
            <Textarea
              id="custom-metric-edit-note"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              maxLength={NOTE_MAX_LENGTH}
              rows={2}
            />
          </div>
          {editError ? (
            <p className="text-destructive text-sm" role="alert">
              {editError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={closeEdit}
              disabled={updateMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              {t("common.save")}
            </Button>
          </div>
        </form>
      </ResponsiveSheet>
    </>
  );
}
