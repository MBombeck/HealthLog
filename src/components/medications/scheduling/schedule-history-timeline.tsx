"use client";

/**
 * v1.16.5 — Zeitplan-tab schedule-history timeline.
 *
 * The ledger and compliance tallies have minted past days against
 * archived schedule eras since v1.16.3; this is the missing management
 * surface. A quiet vertical timeline under the times editor:
 *
 *   - the live plan as the accent node ("Aktueller Plan seit {Datum}",
 *     with its times when the parent passes them),
 *   - predecessor eras collapsed behind a count toggle — each row reads
 *     "07:00 / 19:00 · 12.03.2026 – 01.06.2026", read-only,
 *   - a "Frühere Ära ergänzen" flow for pre-tracking history: the
 *     dialog collects daily times (the existing `TimesOfDayChips`
 *     idiom) plus a Von/Bis date pair and POSTs a MANUAL revision,
 *   - MANUAL eras carry a tinted chip and a delete affordance
 *     (confirmed via AlertDialog); write-path archives are immutable
 *     and render without one.
 *   - v1.16.6: every era row carries an edit pencil. The dialog opens
 *     prefilled like the add flow; a MANUAL era PATCHes in place, an
 *     ARCHIVED era shows a quiet hint that the change corrects the
 *     recorded history (the server mints a superseding MANUAL row and
 *     keeps the original as the audit record).
 *
 * The "Bis" date is the day the NEXT plan took over (exclusive bound) —
 * the dialog copy says so, and adjacency with the live plan is the
 * common case. Dates convert to instants at the browser's local
 * midnight, matching the user's wall clock like every schedule input.
 */
import { useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  History,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

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
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { TimesOfDayChips } from "@/components/medications/scheduling/times-of-day-chips";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface RevisionEntrySummary {
  timesOfDay: string[];
  label: string | null;
  dose: string | null;
  scheduleType: string;
}

export interface ScheduleRevisionRow {
  id: string;
  validFrom: string;
  validUntil: string;
  source: "ARCHIVED" | "MANUAL";
  entries: RevisionEntrySummary[];
}

interface ScheduleRevisionsResponse {
  currentSince: string;
  revisions: ScheduleRevisionRow[];
}

/**
 * Dose-time readout of one era: the union of its entries' times,
 * deduped + sorted ("07:00 / 19:00"). PRN-only eras have no times —
 * the caller renders its own placeholder for an empty result.
 */
export function eraTimes(entries: RevisionEntrySummary[]): string[] {
  const all = entries.flatMap((e) =>
    Array.isArray(e.timesOfDay) ? e.timesOfDay : [],
  );
  return [...new Set(all)].sort((a, b) => a.localeCompare(b));
}

export function ScheduleHistoryTimeline({
  medicationId,
  currentTimes,
  defaultExpanded = false,
}: {
  medicationId: string;
  /** Live-plan dose times the parent already holds (deduped here). */
  currentTimes: string[];
  /** Start with the predecessor eras unfolded (default collapsed). */
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduleRevisionRow | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ScheduleRevisionRow | null>(
    null,
  );

  const { data, isError } = useQuery({
    queryKey: queryKeys.medicationScheduleRevisions(medicationId),
    queryFn: async () =>
      apiGet<ScheduleRevisionsResponse>(
        `/api/medications/${medicationId}/schedule-revisions`,
      ),
    staleTime: 30_000,
  });

  const liveTimes = useMemo(
    () => [...new Set(currentTimes)].sort((a, b) => a.localeCompare(b)),
    [currentTimes],
  );

  const remove = useMutation({
    mutationFn: async (revisionId: string) => {
      await apiDelete(
        `/api/medications/${medicationId}/schedule-revisions/${revisionId}`,
      );
    },
    onSuccess: () => {
      toast.success(t("medications.detail.zeitplan.history.deletedToast"));
      // An era delete re-segments history — the ledger, compliance, and
      // cadence reads under this medication's prefix all go stale.
      queryClient.invalidateQueries({
        queryKey: queryKeys.medicationDetail(medicationId),
      });
    },
    onError: () => {
      toast.error(t("medications.detail.zeitplan.history.deleteError"));
    },
  });

  if (isError) {
    return (
      <p className="text-muted-foreground text-sm" data-slot="zeitplan-history">
        {t("medications.detail.zeitplan.history.loadError")}
      </p>
    );
  }
  if (!data) return null;

  const revisions = data.revisions;

  return (
    <div className="space-y-3" data-slot="zeitplan-history">
      <ol className="space-y-0">
        {/* Live plan — the accent node. */}
        <TimelineRow
          dotClassName="bg-success"
          railVisible={expanded && revisions.length > 0}
          dataSlot="zeitplan-history-current"
        >
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium tabular-nums">
              {liveTimes.length > 0
                ? liveTimes.join(" / ")
                : t("medications.detail.zeitplan.history.noTimes")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("medications.detail.zeitplan.history.currentSince", {
                date: fmt.date(data.currentSince),
              })}
            </p>
          </div>
        </TimelineRow>

        {/* Predecessor eras — newest first, only when expanded. */}
        {expanded &&
          revisions.map((revision, idx) => {
            const times = eraTimes(revision.entries);
            return (
              <TimelineRow
                key={revision.id}
                dotClassName="bg-muted-foreground/50"
                railVisible={idx < revisions.length - 1}
                dataSlot="zeitplan-history-era"
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-foreground text-sm tabular-nums">
                      {times.length > 0
                        ? times.join(" / ")
                        : t("medications.detail.zeitplan.history.noTimes")}
                      {revision.source === "MANUAL" && (
                        <span
                          className="border-primary/30 bg-primary/10 text-primary ml-2 inline-flex rounded-full border px-2 py-px align-middle text-xs font-medium"
                          data-slot="zeitplan-history-manual-chip"
                        >
                          {t("medications.detail.zeitplan.history.manualChip")}
                        </span>
                      )}
                    </p>
                    {/* `validFrom` / `validUntil` (like `currentSince`
                        above) are real era-boundary instants
                        (`@db.Timestamptz`, the moment an edit archived the
                        plan) — NOT `@db.Date` calendar dates — so the
                        profile-timezone formatter renders the correct
                        local day (issue #490 audit). */}
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {fmt.date(revision.validFrom)}
                      {" – "}
                      {fmt.date(revision.validUntil)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground size-11 sm:size-8"
                      aria-label={t(
                        "medications.detail.zeitplan.history.editAria",
                      )}
                      onClick={() => setEditTarget(revision)}
                      data-slot="zeitplan-history-edit"
                    >
                      <Pencil className="size-4" aria-hidden="true" />
                    </Button>
                    {revision.source === "MANUAL" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-11 sm:size-8"
                        aria-label={t(
                          "medications.detail.zeitplan.history.deleteAria",
                        )}
                        disabled={remove.isPending}
                        onClick={() => setDeleteTarget(revision)}
                        data-slot="zeitplan-history-delete"
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                </div>
              </TimelineRow>
            );
          })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        {revisions.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-slot="zeitplan-history-toggle"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
            {expanded
              ? t("medications.detail.zeitplan.history.hideEras")
              : revisions.length === 1
                ? t("medications.detail.zeitplan.history.showErasOne")
                : t("medications.detail.zeitplan.history.showErasOther", {
                    count: revisions.length,
                  })}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
          data-slot="zeitplan-history-add"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("medications.detail.zeitplan.history.addEra")}
        </Button>
      </div>

      <EraDialog
        key={editTarget?.id ?? "add"}
        medicationId={medicationId}
        target={editTarget}
        open={addOpen || editTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setAddOpen(false);
            setEditTarget(null);
          }
        }}
        onSaved={() => setExpanded(true)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.detail.zeitplan.history.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("medications.detail.zeitplan.history.deleteConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("medications.detail.zeitplan.history.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) remove.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              {t("medications.detail.zeitplan.history.deleteConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * One timeline node: dot + optional rail segment down to the next row.
 * The rail is a plain absolutely-positioned line (not `border-l` on the
 * list) so the last row never paints a dangling tail.
 */
function TimelineRow({
  dotClassName,
  railVisible,
  dataSlot,
  children,
}: {
  dotClassName: string;
  railVisible: boolean;
  dataSlot: string;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pb-4 pl-6 last:pb-0" data-slot={dataSlot}>
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-1.5 left-0 size-2 rounded-full",
          dotClassName,
        )}
      />
      {railVisible && (
        <span
          aria-hidden="true"
          className="bg-border/70 absolute top-4 bottom-0 left-[3.5px] w-px"
        />
      )}
      {children}
    </li>
  );
}

/** ISO instant → the local calendar date a `DateInput` understands. */
function toLocalDateInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * "Frühere Ära ergänzen" / "Ära bearbeiten" — collects daily dose times
 * + the Von/Bis date pair. Without a `target` it POSTs a MANUAL
 * revision; with one it PATCHes the era (a MANUAL era updates in place,
 * an ARCHIVED era gets a superseding correction — the dialog shows a
 * quiet hint that the recorded history is being corrected). The parent
 * remounts the dialog via `key` per target, so the prefill is a plain
 * lazy state init. Client-side guards mirror the server validation
 * (times present, Von before Bis); the server stays authoritative for
 * overlap / before-current-plan and its message surfaces through the
 * error toast.
 */
function EraDialog({
  medicationId,
  target,
  open,
  onOpenChange,
  onSaved,
}: {
  medicationId: string;
  /** Era being edited; null = the add flow. */
  target: ScheduleRevisionRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.30 mobile audit (M-4) — the footer's submit Button lives outside the
  // form's DOM subtree once the sheet swaps to `ResponsiveSheet` (the
  // Sheet/Dialog primitive owns the footer slot), so it associates via the
  // native `form` attribute rather than nesting inside `<form>` — the same
  // pattern `log-intake-dialog.tsx` uses.
  const formId = useId();
  const [times, setTimes] = useState<string[]>(() =>
    target ? eraTimes(target.entries) : [],
  );
  const [fromDate, setFromDate] = useState(() =>
    target ? toLocalDateInput(target.validFrom) : "",
  );
  const [untilDate, setUntilDate] = useState(() =>
    target ? toLocalDateInput(target.validUntil) : "",
  );
  const [validationKey, setValidationKey] = useState<
    "timesMissing" | "rangeMissing" | "rangeOrder" | null
  >(null);

  function reset() {
    setTimes(target ? eraTimes(target.entries) : []);
    setFromDate(target ? toLocalDateInput(target.validFrom) : "");
    setUntilDate(target ? toLocalDateInput(target.validUntil) : "");
    setValidationKey(null);
  }

  const create = useMutation({
    mutationFn: async (input: {
      validFrom: string;
      validUntil: string;
      timesOfDay: string[];
    }) =>
      target
        ? apiPatch<ScheduleRevisionRow>(
            `/api/medications/${medicationId}/schedule-revisions/${target.id}`,
            input,
          )
        : apiPost<ScheduleRevisionRow>(
            `/api/medications/${medicationId}/schedule-revisions`,
            input,
          ),
    onSuccess: () => {
      toast.success(
        target
          ? t("medications.detail.zeitplan.history.updatedToast")
          : t("medications.detail.zeitplan.history.createdToast"),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.medicationDetail(medicationId),
      });
      onOpenChange(false);
      reset();
      onSaved();
    },
    onError: () => {
      toast.error(
        target
          ? t("medications.detail.zeitplan.history.updateError")
          : t("medications.detail.zeitplan.history.createError"),
      );
    },
  });

  function submit() {
    if (times.length === 0) {
      setValidationKey("timesMissing");
      return;
    }
    if (!fromDate || !untilDate) {
      setValidationKey("rangeMissing");
      return;
    }
    // Local-midnight instants: the era bounds follow the user's wall
    // clock, the same way every schedule time input does.
    const from = new Date(`${fromDate}T00:00:00`);
    const until = new Date(`${untilDate}T00:00:00`);
    if (from.getTime() >= until.getTime()) {
      setValidationKey("rangeOrder");
      return;
    }
    setValidationKey(null);
    create.mutate({
      validFrom: from.toISOString(),
      validUntil: until.toISOString(),
      timesOfDay: times,
    });
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={
        target
          ? t("medications.detail.zeitplan.history.editEraTitle")
          : t("medications.detail.zeitplan.history.addEraTitle")
      }
      description={
        target
          ? t("medications.detail.zeitplan.history.editEraDescription")
          : t("medications.detail.zeitplan.history.addEraDescription")
      }
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t("medications.detail.zeitplan.history.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={create.isPending}
            aria-busy={create.isPending || undefined}
            data-slot="zeitplan-history-submit"
          >
            {create.isPending ? (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <History className="size-4" aria-hidden="true" />
            )}
            {t("medications.detail.zeitplan.history.submit")}
          </Button>
        </>
      }
    >
      {target?.source === "ARCHIVED" && (
        <p
          className="text-muted-foreground mb-3 text-xs"
          data-slot="zeitplan-history-archived-hint"
        >
          {t("medications.detail.zeitplan.history.archivedEditHint")}
        </p>
      )}
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (create.isPending) return;
          submit();
        }}
        className="space-y-4"
      >
        <div className="space-y-1.5">
          <p className="text-sm font-medium">
            {t("medications.detail.zeitplan.history.timesLabel")}
          </p>
          <TimesOfDayChips value={times} onChange={setTimes} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="zeitplan-history-from">
              {t("medications.detail.zeitplan.history.fromLabel")}
            </Label>
            <DateField
              id="zeitplan-history-from"
              value={fromDate}
              onChange={setFromDate}
              data-testid="zeitplan-history-from"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="zeitplan-history-until">
              {t("medications.detail.zeitplan.history.untilLabel")}
            </Label>
            <DateField
              id="zeitplan-history-until"
              value={untilDate}
              onChange={setUntilDate}
              data-testid="zeitplan-history-until"
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t("medications.detail.zeitplan.history.untilHint")}
        </p>
        {validationKey !== null && (
          <p
            className="text-destructive text-sm"
            role="alert"
            data-slot="zeitplan-history-validation"
          >
            {validationKey === "timesMissing" &&
              t("medications.detail.zeitplan.history.validationTimes")}
            {validationKey === "rangeMissing" &&
              t("medications.detail.zeitplan.history.validationRangeMissing")}
            {validationKey === "rangeOrder" &&
              t("medications.detail.zeitplan.history.validationRangeOrder")}
          </p>
        )}
      </form>
    </ResponsiveSheet>
  );
}
