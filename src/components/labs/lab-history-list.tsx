"use client";

import { DayLinkStated } from "@/components/day/day-link";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
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
  SeededFormDiscardDialog,
  useSeededFormDismissal,
} from "@/components/forms/use-seeded-form-dismissal";
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
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { formatLabReading } from "@/lib/labs/format-value";
import { resolveNoteForUpdate } from "@/lib/labs/note-update";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { ReferenceRangeBadge } from "./reference-range-badge";
import { LabReferenceRangeBar } from "./lab-reference-range-bar";
import { SourceRangeNote } from "./source-range-note";
import type { LabResultDetailDto, LabResultDto } from "./types";
import { useLabDate, useLabNumber } from "./use-lab-format";

const NOTE_MAX_LENGTH = 2000;

// The sample-date column opens descending (newest first); every other column
// opens ascending.
const LAB_DESC_COLUMNS = new Set(["takenAt"]);

// Stable ordering for the reference-range column so a sort produces a
// predictable below → in-range → above → unknown progression.
const RANGE_RANK: Record<string, number> = {
  below: 0,
  "in-range": 1,
  above: 2,
  unknown: 3,
};

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function parseDecimal(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * v1.18.1 — reverse-chronological reading history for one biomarker, with
 * full edit + delete (L5). Edit opens a sheet that loads the decrypted note
 * from the single-resource GET; delete soft-deletes with an Undo toast that
 * restores via `/api/labs/restore` (the measurement pattern). An edit
 * overwrites in place — there is no append-only amendment trail.
 */
export function LabHistoryList({ readings }: { readings: LabResultDto[] }) {
  const { t } = useTranslations();
  const labNumber = useLabNumber();
  const labDate = useLabDate();
  const { canManageDomain } = useRecordCapabilities();
  // What the day shows at its top when opened from a reading: the value and
  // the reading before it, the comparison a draw is read against.
  const chronological = [...readings].sort(
    (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
  );
  const labDayFocus = (reading: LabResultDto) => {
    const at = chronological.findIndex((r) => r.id === reading.id);
    const before = at > 0 ? chronological[at - 1] : undefined;
    return {
      label: reading.analyte,
      // The number and its unit apart, as the day sets every value.
      value:
        reading.value === null
          ? (reading.valueText ?? "")
          : labNumber(reading.value),
      unit: reading.value === null ? undefined : reading.unit,
      compare: before
        ? {
            label: t("day.previousReading", { date: labDate(before.takenAt) }),
            value: formatLabReading(before, labNumber),
          }
        : undefined,
    };
  };
  const canManageLabs = canManageDomain("labs");
  const queryClient = useQueryClient();

  // Client-side column sort over the in-memory reading feed.
  const { sortBy, sortDir, toggleSort } = useTableSort({
    defaultColumn: "takenAt",
    defaultDir: "desc",
    descColumns: LAB_DESC_COLUMNS,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // v1.18.9 — true when the row being edited is a qualitative reading; the
  // editor then shows a text field and the PUT carries `valueText`.
  const [editIsQualitative, setEditIsQualitative] = useState(false);
  const [editValueText, setEditValueText] = useState("");
  const [editTakenAt, setEditTakenAt] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editSeed, setEditSeed] = useState({
    value: "",
    valueText: "",
    takenAt: "",
    note: "",
  });
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // True when the decrypted-note GET failed to load for the row being edited.
  // We must NOT send `note: null` in that case — an empty editor then would
  // wipe a note we simply couldn't read. Instead the PUT omits `note` so the
  // server preserves the stored ciphertext untouched.
  const [noteLoadFailed, setNoteLoadFailed] = useState(false);
  const [hasNote, setHasNote] = useState(false);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: queryKeys.labResults() });
    // v1.32.19 — a lab reading edit / delete / restore shifts the two most
    // recent panels the Insights "what changed since your last panel" card
    // reads, so bust it too instead of leaving it on its pre-write deltas
    // until the 60 s stale window lapses.
    queryClient.invalidateQueries({
      queryKey: queryKeys.insightsLabsChanges(),
    });
  }

  async function restore(id: string) {
    try {
      await apiPost("/api/labs/restore", { ids: [id] });
      invalidate();
      toast.success(t("labs.restoredToast"));
    } catch {
      toast.error(t("labs.restoreError"));
    }
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/labs/${id}`),
    onSuccess: (_data, id) => {
      invalidate();
      toast.success(t("labs.deletedToast"), {
        action: {
          label: t("common.undo"),
          onClick: () => void restore(id),
        },
      });
    },
    onError: () => toast.error(t("labs.deleteError")),
  });

  const updateMutation = useMutation({
    mutationFn: (body: {
      id: string;
      // Exactly one of value / valueText is set, matching the row's type.
      value: number | null;
      valueText: string | null;
      takenAt: string;
      // `undefined` → omit `note` from the PUT (leave the stored note
      // untouched); `null` → clear it; a string → set it.
      note: string | null | undefined;
    }) =>
      apiPut<LabResultDto>(`/api/labs/${body.id}`, {
        ...(body.value !== null ? { value: body.value } : {}),
        ...(body.valueText !== null ? { valueText: body.valueText } : {}),
        takenAt: body.takenAt,
        ...(body.note === undefined ? {} : { note: body.note }),
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t("labs.editedToast"));
      setEditSeed({
        value: editValue,
        valueText: editValueText,
        takenAt: editTakenAt,
        note: editNote,
      });
      dismissEdit();
    },
    onError: (err) => {
      setEditError(localizedApiError(err, t, "labs.editError"));
    },
  });
  const editDismissal = useSeededFormDismissal({
    seed: editSeed,
    value: {
      value: editValue,
      valueText: editValueText,
      takenAt: editTakenAt,
      note: editNote,
    },
    blocked: updateMutation.isPending,
  });

  async function openEdit(reading: LabResultDto) {
    const seed = {
      value: reading.value !== null ? String(reading.value) : "",
      valueText: reading.valueText ?? "",
      takenAt: toDateTimeLocal(reading.takenAt),
      note: "",
    };
    setEditingId(reading.id);
    const qualitative = reading.value === null;
    setEditIsQualitative(qualitative);
    setEditValue(seed.value);
    setEditValueText(seed.valueText);
    setEditTakenAt(seed.takenAt);
    setEditNote(seed.note);
    setEditSeed(seed);
    setEditError(null);
    setNoteLoadFailed(false);
    setHasNote(reading.hasNote);
    // Load the decrypted note (list rows withhold it).
    setEditLoading(true);
    try {
      const detail = await apiGet<LabResultDetailDto>(
        `/api/labs/${reading.id}`,
      );
      setEditNote(detail.note ?? "");
      setEditSeed({ ...seed, note: detail.note ?? "" });
    } catch {
      // The note couldn't be loaded. Flag it so the submit path omits `note`
      // (preserving the stored ciphertext) rather than sending `null` and
      // wiping a note we just failed to read.
      setNoteLoadFailed(true);
    } finally {
      setEditLoading(false);
    }
  }

  function dismissEdit() {
    setEditingId(null);
    setEditError(null);
  }

  function closeEdit() {
    editDismissal.requestClose(dismissEdit);
  }

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    let numericValue: number | null = null;
    let qualitativeValue: string | null = null;
    if (editIsQualitative) {
      const trimmed = editValueText.trim();
      if (trimmed === "") {
        setEditError(t("labs.form.requiredError"));
        return;
      }
      qualitativeValue = trimmed;
    } else {
      numericValue = parseDecimal(editValue);
      if (numericValue === null) {
        setEditError(t("labs.form.requiredError"));
        return;
      }
    }
    const takenDate = new Date(editTakenAt);
    if (Number.isNaN(takenDate.getTime())) {
      setEditError(t("labs.editTimestampError"));
      return;
    }
    updateMutation.mutate({
      id: editingId,
      value: numericValue,
      valueText: qualitativeValue,
      takenAt: takenDate.toISOString(),
      // `undefined` → omit `note` (server preserves the stored note when its
      // decrypted load failed); `null` → clear; text → set.
      note: resolveNoteForUpdate({
        noteLoadFailed,
        hadNote: hasNote,
        editorValue: editNote,
      }),
    });
  }

  const ordered = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...readings].sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "value": {
          // Numeric rows compare by value; qualitative rows (value null) sort
          // after the numeric ones and tie-break on their text.
          if (a.value !== null && b.value !== null) {
            cmp = a.value - b.value;
          } else if (a.value === null && b.value === null) {
            cmp = (a.valueText ?? "").localeCompare(b.valueText ?? "");
          } else {
            cmp = a.value === null ? 1 : -1;
          }
          break;
        }
        case "range":
          cmp =
            (RANGE_RANK[a.rangeStatus] ?? 99) -
            (RANGE_RANK[b.rangeStatus] ?? 99);
          break;
        case "note":
          cmp = Number(a.hasNote) - Number(b.hasNote);
          break;
        case "takenAt":
        default:
          cmp = new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime();
          break;
      }
      // Stable secondary ordering by sample date keeps ties deterministic.
      if (cmp === 0) {
        cmp = new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime();
      }
      return cmp * dir;
    });
  }, [readings, sortBy, sortDir]);

  // One action pair per reading, shared by the phone list and the table.
  const renderActions = (r: LabResultDto) => (
    <div className="flex items-center justify-end gap-1">
      {canManageLabs && (
        <Button
          size="icon"
          variant="ghost"
          // v1.18.10 (W10) — 44px touch target on mobile (WCAG
          // 2.5.5), compact 36px on desktop.
          className="size-11 sm:size-9"
          onClick={() => void openEdit(r)}
          aria-label={t("labs.editReading")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      <DeleteButton
        domain="labs"
        onConfirm={() => deleteMutation.mutate(r.id)}
        title={t("labs.deleteConfirmTitle")}
        description={t("labs.deleteConfirmDescription")}
        confirmLabel={t("labs.deleteReading")}
        className="size-11 sm:size-9"
        iconClassName="h-4 w-4"
      />
    </div>
  );

  return (
    <>
      {/* Phones get one stacked row per reading. The table needs ~510 px for
          its five columns, so on a phone it panned sideways inside its
          container and parked the edit / delete buttons off-screen, while the
          range bar's end labels were clipped by the same container. */}
      <ul
        data-slot="lab-history-mobile-list"
        className="divide-border divide-y lg:hidden"
      >
        {ordered.map((r) => (
          <li key={r.id} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="font-semibold tabular-nums">
                {formatLabReading(r, labNumber)}
              </div>
              <LabReferenceRangeBar
                value={r.value}
                referenceLow={r.referenceLow}
                referenceHigh={r.referenceHigh}
                unit={r.unit}
              />
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <DayLinkStated
                  at={r.takenAt}
                  focus={labDayFocus(r)}
                  className="whitespace-nowrap"
                >
                  {labDate(r.takenAt)}
                </DayLinkStated>
                <ReferenceRangeBadge status={r.rangeStatus} />
                {r.hasNote ? (
                  <span className="text-xs">{t("labs.hasNote")}</span>
                ) : null}
              </div>
              <SourceRangeNote
                reading={r}
                className="text-muted-foreground text-xs"
              />
            </div>
            {renderActions(r)}
          </li>
        ))}
      </ul>
      <div data-slot="lab-history-table" className="max-lg:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                column="value"
                label={t("labs.form.value")}
                currentSort={sortBy}
                currentDir={sortDir}
                onSort={toggleSort}
              />
              <SortableHead
                column="takenAt"
                label={t("labs.form.takenAt")}
                currentSort={sortBy}
                currentDir={sortDir}
                onSort={toggleSort}
              />
              <SortableHead
                column="range"
                label={t("labs.referenceLabel")}
                currentSort={sortBy}
                currentDir={sortDir}
                onSort={toggleSort}
              />
              <SortableHead
                column="note"
                label={t("labs.hasNote")}
                currentSort={sortBy}
                currentDir={sortDir}
                onSort={toggleSort}
              />
              <TableHead className="w-20 pr-4 text-right">
                <span className="sr-only">{t("labs.editReading")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-semibold tabular-nums">
                  <div className="space-y-2">
                    <span>{formatLabReading(r, labNumber)}</span>
                    <LabReferenceRangeBar
                      value={r.value}
                      referenceLow={r.referenceLow}
                      referenceHigh={r.referenceHigh}
                      unit={r.unit}
                    />
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                  {/* v1.42 — the draw date opens the day; the row keeps its
                      edit and delete. A draw day is often a visit day. */}
                  <DayLinkStated at={r.takenAt} focus={labDayFocus(r)}>
                    {labDate(r.takenAt)}
                  </DayLinkStated>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col items-start gap-1">
                    <ReferenceRangeBadge status={r.rangeStatus} />
                    <SourceRangeNote
                      reading={r}
                      className="text-muted-foreground text-xs"
                    />
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {r.hasNote ? t("labs.hasNote") : ""}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {renderActions(r)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ResponsiveSheet
        open={editingId !== null}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
        title={t("labs.editTitle")}
        description={t("labs.editDescription")}
      >
        <form onSubmit={submitEdit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lab-edit-value">
                {editIsQualitative
                  ? t("labs.form.qualitativeResult")
                  : t("labs.form.value")}
              </Label>
              {editIsQualitative ? (
                <Input
                  id="lab-edit-value"
                  value={editValueText}
                  onChange={(e) => setEditValueText(e.target.value)}
                  maxLength={120}
                  required
                />
              ) : (
                <Input
                  id="lab-edit-value"
                  inputMode="decimal"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  required
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lab-edit-takenAt">{t("labs.form.takenAt")}</Label>
              <DateTimeField
                id="lab-edit-takenAt"
                value={editTakenAt}
                onChange={setEditTakenAt}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lab-edit-note">{t("labs.form.note")}</Label>
            <Textarea
              id="lab-edit-note"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              maxLength={NOTE_MAX_LENGTH}
              rows={2}
              disabled={editLoading || (noteLoadFailed && hasNote)}
            />
            {noteLoadFailed && hasNote ? (
              <p className="text-muted-foreground text-xs">
                {t("labs.noteLoadFailed")}
              </p>
            ) : null}
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
      <SeededFormDiscardDialog
        open={editDismissal.discardDialogOpen}
        onConfirm={editDismissal.confirmDiscard}
        onCancel={editDismissal.cancelDiscard}
      />
    </>
  );
}
