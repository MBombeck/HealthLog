"use client";

/**
 * v1.15.18 WE — the Verlauf tab's dose-history ledger.
 *
 * Renders the server-minted ledger (`GET /api/medications/[id]/dose-history`):
 * EVERY expected slot with its status (pünktlich / verspätet / übersprungen /
 * verpasst / ausstehend) even when never taken, plus every off-schedule intake
 * as a tagged ad-hoc row at its real time. Rows are grouped by day, most-recent
 * day first, chronological inside the day.
 *
 * Three interactions land here:
 *   - an actionable slot (upcoming, or missed today) exposes ONE visible
 *     [Genommen] button that marks the dose with INSTANT feedback — the
 *     cached ledger + the headline % are mutated optimistically (the engines
 *     are pure, so the client mirrors their accounting) before the server
 *     write fires and the authoritative refetch reconciles. The success
 *     toast carries an Undo. Übersprungen and the backfill of older missed
 *     slots live in the row's overflow kebab;
 *   - settled rows (taken / skipped / a past missed day) carry ONLY the
 *     kebab: Bearbeiten, the Übersprungen↔Genommen toggle, Löschen — so the
 *     ledger reads as a calm record, not a button wall;
 *   - a header "+ Eintrag" opens an add dialog scoped to this medication
 *     (incl. backdated / off-schedule); an off-window take surfaces the
 *     "diesem Slot zuordnen?" nudge, pinning it onto a chosen slot via
 *     `forceSlotInstant` rather than orphaning it to an ad-hoc row;
 *   - v1.15.20: an ad-hoc row shows WHEN the dose would have been due
 *     (`nearestSlot` subline) and — when that slot is still unserved — a
 *     kebab "Slot … zuordnen" action that pins the take onto it after a
 *     confirm that names the consequence ("zählt als verspätet"). A pinned
 *     slot row carries a quiet "zugeordnet" badge and the inverse
 *     "Zuordnung lösen" kebab action (`forceSlotInstant: null`). v1.16.0:
 *     the released row keeps USER_PIN provenance server-side (the dedup
 *     leaves it standalone) and reads as a plain ad-hoc row here — no
 *     badge, since it is no longer bound to a slot.
 *
 * A compact took / skipped history chart sits at the top — the ledger already
 * carries the counts. The card body never tints by status (removed earlier);
 * the ledger uses the semantic feedback vocabulary on the row, not the card.
 */

import {
  useActiveRecordName,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleCheck,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  SkipForward,
  Trash2,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useAuth } from "@/hooks/use-auth";
import {
  useTranslations,
  useFormatters,
  useDateFormatPreference,
} from "@/lib/i18n/context";
import { formatDateWithWeekdaySmart } from "@/lib/date-format";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import type { DoseHistoryStatus } from "@/lib/medications/scheduling/dose-history";
import {
  intakeToastOptions,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import {
  applyOptimisticSlotMark,
  complianceFromLedger,
  formatSlotDelta,
  groupLedgerByDay,
  isSlotActionable,
  slotMarkRequestBody,
  type LedgerPayload,
  type LedgerRow,
} from "@/components/medications/dose-history-ledger-compute";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A schedule slot the add dialog offers for pinning. */
export interface LedgerSchedule {
  windowStart: string;
  label: string | null;
  dose: string | null;
  timesOfDay?: string[];
}

export interface DoseHistoryLedgerProps {
  medicationId: string;
  medicationName: string;
  schedules: LedgerSchedule[];
  /** Trailing window in days the ledger renders. Defaults to 90. */
  windowDays?: number;
}

/** Status → semantic colour token + glyph. Mirrors the card status pill's
 * success / warning / destructive ramp so the surface reads as one vocabulary;
 * skipped + upcoming are calm muted, ad-hoc is the neutral-positive accent. */
const STATUS_TONE: Record<DoseHistoryStatus, string> = {
  taken_on_time: "text-success",
  taken_late: "text-warning",
  skipped: "text-muted-foreground",
  missed: "text-destructive",
  upcoming: "text-muted-foreground",
  ad_hoc: "text-primary",
};

function StatusGlyph({ status }: { status: DoseHistoryStatus }) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "taken_on_time":
      return <CircleCheck aria-hidden="true" className={cls} />;
    case "taken_late":
      return <AlertCircle aria-hidden="true" className={cls} />;
    case "missed":
      return <AlertTriangle aria-hidden="true" className={cls} />;
    case "ad_hoc":
      return <Plus aria-hidden="true" className={cls} />;
    case "skipped":
      return <SkipForward aria-hidden="true" className={cls} />;
    default:
      return null;
  }
}

export function DoseHistoryLedger({
  medicationId,
  medicationName,
  schedules,
  windowDays = 90,
}: DoseHistoryLedgerProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  const { user } = useAuth();
  // v1.36.x — a delegate may record a dose, which is what "add" and the
  // inline "mark taken" do. Editing, deleting, pinning and un-skipping an
  // existing event are the owner's, so the row menu is absent for them.
  const { canAdd } = useRecordCapabilities();
  // The record this ledger's writes land in, when it is not the caller's own.
  // The two sibling intake paths in `use-medication-intake.ts` already drop
  // Undo and name the record; this third one builds its own toast and missed
  // both, so a delegate met an Undo the server refuses on every dose they
  // marked — the most-encountered of the set.
  const recordName = useActiveRecordName();
  const queryClient = useQueryClient();
  const timeZone = user?.timezone || "Europe/Berlin";

  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<{
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  // v1.15.20 — the pending "Slot zuordnen" confirm: which intake to pin
  // onto which slot. The confirm names the consequence (counts as late).
  const [pendingPin, setPendingPin] = useState<{
    eventId: string;
    slotAt: string;
  } | null>(null);

  // Stable window captured once at mount (a lazy state initializer keeps the
  // impure `Date.now()` out of render) so the query key + the `from`/`to`
  // request stay byte-equal across renders rather than re-keying every paint.
  const [{ fromIso, toIso }] = useState(() => {
    const now = Date.now();
    return {
      toIso: new Date(now).toISOString(),
      fromIso: new Date(now - windowDays * DAY_MS).toISOString(),
    };
  });

  const queryKey = queryKeys.medicationDoseHistory(
    medicationId,
    fromIso,
    toIso,
  );

  const { data, isLoading, isError } = useQuery<LedgerPayload>({
    queryKey,
    queryFn: async () => {
      const search = new URLSearchParams({ from: fromIso, to: toIso });
      return apiGet<LedgerPayload>(
        `/api/medications/${medicationId}/dose-history?${search.toString()}`,
      );
    },
    staleTime: 15_000,
  });

  const compliance = useMemo(
    () => (data ? complianceFromLedger(data.rows) : null),
    [data],
  );

  const groups = useMemo(
    () => (data ? groupLedgerByDay(data.rows, timeZone) : []),
    [data, timeZone],
  );

  // Today's local day key — a missed slot from TODAY is still in active
  // play (visible Genommen button); older missed days settle into the
  // row kebab so the history reads calm.
  const todayKey = useMemo(
    () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    [timeZone],
  );

  /**
   * Genommen / Übersprungen on a pending / missed slot. The cached ledger is
   * mutated optimistically (row status + the headline % flip in this paint),
   * then the server write fires and the dependent-key invalidation reconciles.
   * A failed write rolls the optimistic snapshot back + toasts; a successful
   * one carries the same Undo action the medication cards offer (mirrors the
   * C1/C2 pattern in `use-medication-intake.ts`).
   */
  const markSlot = useCallback(
    async (row: LedgerRow, action: "taken" | "skipped") => {
      if (marking || !isSlotActionable(row)) return;
      setMarking(`${row.at}:${action}`);

      const prev = queryClient.getQueryData<LedgerPayload>(queryKey);
      if (prev) {
        queryClient.setQueryData<LedgerPayload>(
          queryKey,
          applyOptimisticSlotMark(prev, row.at, action),
        );
      }

      try {
        // Pin the displayed slot so the server marks THAT dose (the canonical
        // slot upsert), not a now-snap to the nearest one — and anchor
        // `takenAt` on the same instant, matching the optimistic paint. The
        // POST returns the created event; its id drives the Undo affordance
        // (the same soft-delete route the cards use).
        const created = await apiPost<{ id?: string } | undefined>(
          `/api/medications/${medicationId}/intake`,
          slotMarkRequestBody(row, action),
        );
        const eventId: string | undefined = created?.id;
        toast.success(
          t(
            action === "skipped"
              ? "medications.intakeToastSkipped"
              : "medications.intakeToastTaken",
            { name: medicationName },
          ),
          // The shared decision, not a fourth copy of it: name the record it
          // landed in, and withhold an Undo the server would refuse there.
          intakeToastOptions({
            recordName,
            eventId,
            t,
            onUndo: (id) =>
              void runUndoIntake({
                medication: { id: medicationId, name: medicationName },
                eventId: id,
                t,
                queryClient,
              }),
          }),
        );
        await invalidateKeys(queryClient, [
          ...medicationDependentKeys,
          queryKey,
        ]);
        // The ledger also invalidates its own window key above; the daily
        // reads (Today hero + dashboard) are unmounted behind the detail
        // page, so force their inactive refetch too (v1.32.19).
        await refetchInactiveDailyReads(queryClient);
      } catch {
        if (prev) queryClient.setQueryData(queryKey, prev);
        toast.error(
          t("medications.intakeToastFailed", { name: medicationName }),
        );
      } finally {
        setMarking(null);
      }
    },
    [
      marking,
      medicationId,
      medicationName,
      queryClient,
      queryKey,
      recordName,
      t,
    ],
  );

  /**
   * Flip an existing intake between Übersprungen and Genommen from the row
   * kebab. Same `PUT intake/[eventId]` contract the edit dialog uses; a
   * skipped→taken flip anchors `takenAt` on the slot instant (a past slot)
   * rather than "now".
   */
  const toggleIntakeSkipped = useCallback(
    async (intake: {
      id: string;
      skipped: boolean;
      scheduledFor: string | null;
    }) => {
      try {
        const body = intake.skipped
          ? {
              skipped: false,
              takenAt: intake.scheduledFor ?? new Date().toISOString(),
            }
          : { skipped: true, takenAt: null };
        await apiPut(
          `/api/medications/${medicationId}/intake/${intake.id}`,
          body,
        );
        await invalidateKeys(queryClient, [
          ...medicationDependentKeys,
          queryKey,
        ]);
        // The ledger also invalidates its own window key above; the daily
        // reads (Today hero + dashboard) are unmounted behind the detail
        // page, so force their inactive refetch too (v1.32.19).
        await refetchInactiveDailyReads(queryClient);
        toast.success(t("medications.detail.intake.edit.savedToast"));
      } catch {
        toast.error(t("medications.detail.intake.edit.failed"));
      }
    },
    [medicationId, queryClient, queryKey, t],
  );

  /**
   * v1.15.20 — pin an ad-hoc take onto a scheduled slot (`forceSlotInstant`)
   * or release a pinned binding (`forceSlotInstant: null` → the server
   * re-attributes by band, usually back to ad-hoc). Same PUT contract the
   * edit dialog uses; the authoritative refetch re-renders the moved row.
   */
  const setAttribution = useCallback(
    async (eventId: string, slotAtIso: string | null) => {
      try {
        await apiPut(`/api/medications/${medicationId}/intake/${eventId}`, {
          forceSlotInstant: slotAtIso,
        });
        toast.success(
          t(
            slotAtIso
              ? "medications.detail.verlauf.pin.pinnedToast"
              : "medications.detail.verlauf.pin.unpinnedToast",
          ),
        );
        await invalidateKeys(queryClient, [
          ...medicationDependentKeys,
          queryKey,
        ]);
        // The ledger also invalidates its own window key above; the daily
        // reads (Today hero + dashboard) are unmounted behind the detail
        // page, so force their inactive refetch too (v1.32.19).
        await refetchInactiveDailyReads(queryClient);
      } catch {
        toast.error(t("medications.detail.intake.edit.failed"));
      }
    },
    [medicationId, queryClient, queryKey, t],
  );

  async function confirmRowDelete() {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    try {
      await apiDelete(`/api/medications/${medicationId}/intake/${id}`);
      toast.success(t("medications.detail.intake.deleteRow.toast"));
      await invalidateKeys(queryClient, [...medicationDependentKeys, queryKey]);
      // The ledger also invalidates its own window key above; the daily
      // reads (Today hero + dashboard) are unmounted behind the detail
      // page, so force their inactive refetch too (v1.32.19).
      await refetchInactiveDailyReads(queryClient);
    } catch {
      toast.error(t("medications.detail.intake.deleteRow.failed"));
    }
  }

  return (
    <div className="space-y-4" data-slot="dose-history-ledger">
      {/* Header: the took/skipped summary chart + the add affordance. */}
      <div className="flex items-start justify-between gap-3">
        {compliance && compliance.denominator > 0 ? (
          <LedgerSummaryChart compliance={compliance} />
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("medications.detail.verlauf.summaryEmpty")}
          </p>
        )}
        {canAdd && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="ledger-add"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.verlauf.add")}
          </Button>
        )}
      </div>

      {isLoading && (
        <div
          className="text-muted-foreground flex items-center gap-2 py-6 text-sm"
          role="status"
          aria-busy="true"
        >
          <Loader2
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          {t("medications.detail.verlauf.loading")}
        </div>
      )}

      {isError && (
        <p className="text-destructive py-6 text-sm">
          {t("medications.detail.verlauf.loadError")}
        </p>
      )}

      {data && !isLoading && groups.length === 0 && (
        <p className="text-muted-foreground py-6 text-sm">
          {t("medications.detail.verlauf.empty")}
        </p>
      )}

      {data &&
        groups.map((group) => (
          <section
            key={group.dayKey}
            className="space-y-1"
            data-slot="ledger-day"
            data-day={group.dayKey}
          >
            <h3 className="text-muted-foreground px-1 text-xs font-medium">
              {/* Issue #490 — `dayKey` is a profile-timezone calendar day.
                  The old browser-local-midnight parse re-interpreted it in
                  the DEVICE zone and could shift the heading a day when
                  browser ≠ profile zone; the day-key label renders
                  UTC-pinned instead (zone-independent, weekday included). */}
              {formatDateWithWeekdaySmart(group.dayKey, dateFormatPref, locale)}
            </h3>
            <ul className="border-border/60 divide-border/60 divide-y rounded-md border">
              {group.rows.map((row, i) => (
                <LedgerRowItem
                  key={`${row.kind}:${row.at}:${row.intake?.id ?? i}`}
                  row={row}
                  marking={marking}
                  isToday={group.dayKey === todayKey}
                  onMark={markSlot}
                  onToggleSkipped={toggleIntakeSkipped}
                  onEdit={(ev) => setEditingEvent(ev)}
                  onDelete={(id) => setPendingDeleteId(id)}
                  onPin={(eventId, slotAt) =>
                    setPendingPin({ eventId, slotAt })
                  }
                  onUnpin={(eventId) => void setAttribution(eventId, null)}
                />
              ))}
            </ul>
          </section>
        ))}

      <IntakeEditDialog
        medicationId={medicationId}
        event={editingEvent}
        onClose={() => setEditingEvent(null)}
      />

      {addOpen && (
        <LedgerAddDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          medicationId={medicationId}
          medicationName={medicationName}
          schedules={schedules}
          ledgerKey={queryKey}
        />
      )}

      {pendingDeleteId && (
        <DeleteRowConfirm
          onConfirm={() => void confirmRowDelete()}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {pendingPin && (
        <PinConfirm
          slotLabel={fmt.time(new Date(pendingPin.slotAt))}
          onConfirm={() => {
            const pin = pendingPin;
            setPendingPin(null);
            void setAttribution(pin.eventId, pin.slotAt);
          }}
          onCancel={() => setPendingPin(null)}
        />
      )}
    </div>
  );
}

/**
 * One ledger row: time + status (colour + glyph + text) + (when an intake is
 * attributed) its real take time, plus the row actions.
 *
 * Action shape (v1.15.20): an actionable slot that is still in play
 * (upcoming, or missed TODAY) carries exactly ONE visible [Genommen] button —
 * label visible on every viewport — plus the overflow kebab (Übersprungen).
 * Every settled row (taken / skipped / a past missed day / ad-hoc) carries
 * ONLY the kebab: Bearbeiten, the Übersprungen↔Genommen toggle, Löschen —
 * and, for a past missed slot, the Genommen / Übersprungen backfill marks.
 *
 * v1.36.x — exported for the delegated-affordance suite. The row's capability
 * gating is the interesting part and the ledger around it needs a payload, a
 * medication and a query client to paint one row.
 */
export function LedgerRowItem({
  row,
  marking,
  isToday,
  onMark,
  onToggleSkipped,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: {
  row: LedgerRow;
  marking: string | null;
  isToday: boolean;
  onMark: (row: LedgerRow, action: "taken" | "skipped") => void;
  onToggleSkipped: (intake: {
    id: string;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  onEdit: (event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  onDelete: (id: string) => void;
  /** Open the pin confirm for an ad-hoc take onto the named slot (ISO). */
  onPin: (eventId: string, slotAt: string) => void;
  /** Release a pinned binding (server re-attributes by band). */
  onUnpin: (eventId: string) => void;
}) {
  const { t } = useTranslations();
  const { canAdd, canManageDomain } = useRecordCapabilities();
  const canManageMedications = canManageDomain("medications");
  const fmt = useFormatters();

  const actionable = isSlotActionable(row);
  // A missed slot from an earlier day stays markable, but only through the
  // kebab — the visible button is reserved for doses still in play.
  const showTakenButton = actionable && (row.status === "upcoming" || isToday);
  const intake = row.intake;
  const takeBusy = marking === `${row.at}:taken`;
  const skipBusy = marking === `${row.at}:skipped`;

  // The leading time label: the slot's HH:mm for a slot row, else the ad-hoc
  // take's real clock time.
  const timeLabel =
    row.timeOfDay ?? fmt.time(new Date(intake?.takenAt ?? row.at));

  // When a take lands away from its slot, show both anchors so the row reads
  // "geplant 07:00 · genommen 11:29".
  const showTakeDetail =
    row.kind === "slot" &&
    intake?.takenAt &&
    (row.status === "taken_on_time" || row.status === "taken_late");

  // v1.15.20 — an ad-hoc take with a due-context shows WHEN the dose would
  // have been due; the pin action additionally needs the slot unserved and a
  // real persisted event to re-anchor.
  const dueContext =
    row.kind === "ad_hoc" && intake?.takenAt && row.nearestSlot
      ? row.nearestSlot
      : null;
  const canPin = Boolean(dueContext && !dueContext.filled && intake?.id);
  const canUnpin = Boolean(row.kind === "slot" && row.pinned && intake?.id);

  return (
    <li
      className="flex items-center justify-between gap-2 px-3 py-2"
      data-slot="ledger-row"
      data-status={row.status}
      data-kind={row.kind}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium tabular-nums">
            {timeLabel}
          </span>
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${STATUS_TONE[row.status]}`}
            data-slot="ledger-status"
          >
            <StatusGlyph status={row.status} />
            {t(`medications.detail.verlauf.status.${row.status}`)}
          </span>
          {row.kind === "ad_hoc" && (
            <Badge variant="outline" className="text-2xs">
              {t("medications.detail.verlauf.adHocTag")}
            </Badge>
          )}
          {/* v1.16.0 — the "zugeordnet" badge only when the row is actually
              bound to a slot. A released ("Zuordnung lösen") USER_PIN take
              surfaces as an ad-hoc row that also carries `pinned`; badging
              it "zugeordnet" would claim the binding the user just released. */}
          {row.kind === "slot" && row.pinned && (
            <Badge
              variant="outline"
              className="text-2xs"
              data-slot="ledger-pinned-badge"
            >
              {t("medications.detail.verlauf.pin.pinnedTag")}
            </Badge>
          )}
        </div>
        {showTakeDetail && (
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.verlauf.takenDetail", {
              planned: row.timeOfDay ?? fmt.time(new Date(row.at)),
              taken: fmt.time(new Date(intake!.takenAt!)),
            })}
          </p>
        )}
        {/* v1.16.4 — quiet per-intake dose override note. Only rows whose
            take recorded a deviating dose carry one; the configured dose
            stays implicit, so the ledger's rhythm is undisturbed. */}
        {intake?.doseTaken && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="ledger-dose-taken"
          >
            {t("medications.detail.verlauf.doseTaken", {
              dose: intake.doseTaken,
            })}
          </p>
        )}
        {dueContext && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="ledger-due-context"
          >
            {t("medications.detail.verlauf.pin.dueContext", {
              time: fmt.time(new Date(dueContext.at)),
              delta: formatSlotDelta(intake!.takenAt!, dueContext.at),
            })}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {showTakenButton && canAdd && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMark(row, "taken")}
            disabled={takeBusy || skipBusy}
            aria-busy={takeBusy || undefined}
            className="min-h-9"
            data-slot="ledger-mark-taken"
          >
            {takeBusy ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Check aria-hidden="true" className="size-4" />
            )}
            {t("medications.detail.verlauf.markTaken")}
          </Button>
        )}
        {/* v1.36.x — the other half of the same admitted verb. Marking a dose
            taken OR skipped is one capability, and the medication card offers
            both; this ledger offered a delegate only the first, because skip
            lives in the kebab and the kebab is owner-only (it also holds edit,
            re-attribute and delete). Rather than mix admitted and withheld
            items in one menu, a delegate gets skip as its own control beside
            take, which is the shape the card already uses. The owner keeps it
            where it was. */}
        {showTakenButton && canAdd && !canManageMedications && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMark(row, "skipped")}
            disabled={takeBusy || skipBusy}
            aria-busy={skipBusy || undefined}
            className="min-h-9"
            data-slot="ledger-mark-skipped"
          >
            {skipBusy ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <SkipForward aria-hidden="true" className="size-4" />
            )}
            {t("medications.detail.verlauf.markSkipped")}
          </Button>
        )}
        {canManageMedications && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                aria-label={t("medications.detail.verlauf.rowActionsLabel", {
                  time: timeLabel,
                })}
                data-slot="ledger-row-menu"
              >
                <MoreVertical aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              data-slot="ledger-row-menu-content"
            >
              {actionable && !showTakenButton && (
                <DropdownMenuItem
                  onClick={() => onMark(row, "taken")}
                  data-slot="ledger-menu-taken"
                >
                  <Check aria-hidden="true" className="mr-2 size-4" />
                  {t("medications.detail.verlauf.markTaken")}
                </DropdownMenuItem>
              )}
              {actionable && (
                <DropdownMenuItem
                  onClick={() => onMark(row, "skipped")}
                  data-slot="ledger-mark-skipped"
                >
                  {skipBusy ? (
                    <Loader2
                      aria-hidden="true"
                      className="mr-2 size-4 animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <SkipForward aria-hidden="true" className="mr-2 size-4" />
                  )}
                  {t("medications.detail.verlauf.markSkipped")}
                </DropdownMenuItem>
              )}
              {canPin && (
                <DropdownMenuItem
                  onClick={() => onPin(intake!.id as string, dueContext!.at)}
                  data-slot="ledger-pin"
                >
                  <Link2 aria-hidden="true" className="mr-2 size-4" />
                  {t("medications.detail.verlauf.pin.action", {
                    time: fmt.time(new Date(dueContext!.at)),
                  })}
                </DropdownMenuItem>
              )}
              {canUnpin && (
                <DropdownMenuItem
                  onClick={() => onUnpin(intake!.id as string)}
                  data-slot="ledger-unpin"
                >
                  <Unlink aria-hidden="true" className="mr-2 size-4" />
                  {t("medications.detail.verlauf.pin.release")}
                </DropdownMenuItem>
              )}
              {intake?.id && (
                <>
                  <DropdownMenuItem
                    onClick={() =>
                      onEdit({
                        id: intake.id as string,
                        takenAt: intake.takenAt,
                        skipped: intake.skipped,
                        scheduledFor: intake.scheduledFor,
                      })
                    }
                    data-slot="ledger-edit"
                  >
                    <Pencil aria-hidden="true" className="mr-2 size-4" />
                    {t("medications.detail.intake.rowActions.edit")}
                  </DropdownMenuItem>
                  {(row.status === "skipped" ||
                    row.status === "taken_on_time" ||
                    row.status === "taken_late") && (
                    <DropdownMenuItem
                      onClick={() =>
                        onToggleSkipped({
                          id: intake.id as string,
                          skipped: intake.skipped,
                          scheduledFor: intake.scheduledFor,
                        })
                      }
                      data-slot="ledger-toggle-skipped"
                    >
                      {intake.skipped ? (
                        <Check aria-hidden="true" className="mr-2 size-4" />
                      ) : (
                        <SkipForward
                          aria-hidden="true"
                          className="mr-2 size-4"
                        />
                      )}
                      {intake.skipped
                        ? t("medications.detail.verlauf.markAsTaken")
                        : t("medications.detail.verlauf.markAsSkipped")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onDelete(intake.id as string)}
                    className="text-destructive focus:text-destructive"
                    data-slot="ledger-delete"
                  >
                    <Trash2 aria-hidden="true" className="mr-2 size-4" />
                    {t("medications.detail.intake.rowActions.delete")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

/**
 * Compact took / skipped history chart — a single proportional bar split into
 * on-time / late / missed, with the headline rate beside it. No Recharts: a
 * three-segment CSS bar is calmer + lighter for a summary this small, and it
 * tracks the ledger the user is already reading.
 */
function LedgerSummaryChart({
  compliance,
}: {
  compliance: NonNullable<ReturnType<typeof complianceFromLedger>>;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { takenOnTime, takenLate, missed, denominator, rate } = compliance;
  const pct = (n: number) => (denominator > 0 ? (n / denominator) * 100 : 0);

  return (
    <div className="min-w-0 flex-1 space-y-1.5" data-slot="ledger-summary">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium">
          {t("medications.detail.verlauf.adherenceLabel")}
        </span>
        <span className="text-foreground text-sm font-semibold tabular-nums">
          {rate !== null ? `${fmt.number(rate)}%` : "—"}
        </span>
      </div>
      <div
        className="bg-muted flex h-2 overflow-hidden rounded-full"
        role="img"
        aria-label={t("medications.detail.verlauf.adherenceBarLabel", {
          onTime: takenOnTime,
          late: takenLate,
          missed,
        })}
      >
        <div
          className="bg-success h-full"
          style={{ width: `${pct(takenOnTime)}%` }}
        />
        <div
          className="bg-warning h-full"
          style={{ width: `${pct(takenLate)}%` }}
        />
        <div
          className="bg-destructive h-full"
          style={{ width: `${pct(missed)}%` }}
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
        <span className="text-success">
          {t("medications.detail.verlauf.status.taken_on_time")}: {takenOnTime}
        </span>
        <span className="text-warning">
          {t("medications.detail.verlauf.status.taken_late")}: {takenLate}
        </span>
        <span className="text-destructive">
          {t("medications.detail.verlauf.status.missed")}: {missed}
        </span>
      </div>
    </div>
  );
}

/**
 * v1.15.20 — the "Slot zuordnen" confirm. Pinning is a deliberate, visible
 * decision, so the dialog names the consequence before the write: the dose
 * will count as taken LATE for that slot (the rate is served, never
 * flattered) and the row will carry the "zugeordnet" badge until released.
 */
function PinConfirm({
  slotLabel,
  onConfirm,
  onCancel,
}: {
  slotLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-slot="ledger-pin-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("medications.detail.verlauf.pin.confirmTitle", {
              time: slotLabel,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("medications.detail.verlauf.pin.confirmBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("medications.detail.verlauf.pin.confirmCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            data-slot="ledger-pin-confirm-action"
          >
            {t("medications.detail.verlauf.pin.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Lightweight single-row delete confirm — the ledger does not need the full
 * bulk-delete state machine, just a guard. */
function DeleteRowConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("medications.detail.intake.deleteRow.confirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("medications.detail.intake.deleteRow.confirmBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("medications.detail.intake.bulkDelete.cancelButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-destructive dark:bg-destructive/60 hover:bg-destructive/90 text-white"
          >
            {t("medications.detail.intake.deleteRow.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
