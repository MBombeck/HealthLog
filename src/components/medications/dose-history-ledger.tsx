"use client";

/**
 * The Verlauf tab's dose-history ledger.
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
 *   - an ad-hoc row shows WHEN the dose would have been due
 *     (`nearestSlot` subline) and — when that slot is still unserved — a
 *     kebab "Slot … zuordnen" action that pins the take onto it after a
 *     confirm that names the consequence ("zählt als verspätet"). A pinned
 *     slot row carries a quiet "zugeordnet" badge and the inverse
 *     "Zuordnung lösen" kebab action (`forceSlotInstant: null`). The
 *     released row keeps USER_PIN provenance server-side (the dedup
 *     leaves it standalone) and reads as a plain ad-hoc row here — no
 *     badge, since it is no longer bound to a slot.
 *
 * A compact took / skipped history chart sits at the top — the ledger already
 * carries the counts. The card body never tints by status (removed earlier);
 * the ledger uses the semantic feedback vocabulary on the row, not the card.
 */

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { DayLink } from "@/components/day/day-link";
import { LedgerAddDialog } from "@/components/medications/dose-history-add-dialog";
import { IntakeEditDialog } from "@/components/medications/intake-edit-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { formatDateWithWeekdaySmart } from "@/lib/date-format";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";

import { DeleteRowConfirm, PinConfirm } from "./dose-history/ledger-confirms";
import { LedgerRowItem } from "./dose-history/ledger-row-item";
import { LedgerSummaryChart } from "./dose-history/ledger-summary-chart";
import { useDoseHistoryLedger } from "./dose-history/use-dose-history-ledger";

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

export function DoseHistoryLedger({
  medicationId,
  medicationName,
  schedules,
  windowDays = 90,
}: DoseHistoryLedgerProps) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const dateFormatPref = useDateFormatPreference();
  // A delegate may record a dose, which is what "add" and the inline "mark
  // taken" do. Editing, deleting, pinning and un-skipping an existing event
  // are the owner's, so the row menu is absent for them.
  const { canWriteDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");
  const [addOpen, setAddOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<{
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  } | null>(null);
  const {
    queryKey,
    data,
    isLoading,
    isError,
    error,
    refetch,
    compliance,
    groups,
    todayKey,
    marking,
    markSlot,
    toggleIntakeSkipped,
    setAttribution,
    pendingDeleteId,
    setPendingDeleteId,
    confirmRowDelete,
    pendingPin,
    setPendingPin,
  } = useDoseHistoryLedger({ medicationId, medicationName, windowDays });

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
        {canAddIntake && (
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
        <QueryErrorRow
          inset
          error={error}
          slot="dose-history-error"
          message={t("medications.detail.verlauf.loadError")}
          onRetry={() => void refetch()}
          className="py-6"
        />
      )}

      {data && !isLoading && groups.length === 0 && (
        <EmptyState
          variant="plain"
          size="compact"
          title={t("medications.detail.verlauf.empty")}
        />
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
              {/* The day heading opens the whole day: did I take
                  it, and how was that day otherwise. Rows keep their own
                  actions. A planned future slot gets no link. */}
              <DayLink date={group.dayKey}>
                {formatDateWithWeekdaySmart(
                  group.dayKey,
                  dateFormatPref,
                  locale,
                )}
              </DayLink>
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
