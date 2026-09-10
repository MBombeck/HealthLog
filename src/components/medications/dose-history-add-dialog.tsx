"use client";

/**
 * v1.15.18 WE — add-intake dialog scoped to one medication, reached from the
 * Verlauf tab header. A trimmed sibling of `<LogIntakeDialog>` (which spans
 * every active medication from the list page): this one is pre-bound to the
 * medication whose ledger the user is editing, so it drops the medication
 * picker and adds the late-take nudge.
 *
 * The nudge (the maintainer decision): when the picked `takenAt` falls JUST OUTSIDE a
 * slot's on-time window — close enough that it is plausibly that dose, but
 * past the ±1h default band — the dialog offers "diesem Slot zuordnen?". On
 * accept the write carries `forceSlotInstant` (the nearest slot's instant on
 * the chosen day), pinning the take onto that scheduled slot instead of
 * orphaning it to an ad-hoc row. The server validates the instant is a real
 * slot (422 otherwise, surfaced as a toast). Decline → the take records
 * ad-hoc (no `scheduledFor`); an exact slot match pins directly with no nudge.
 */

import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Label } from "@/components/ui/label";
import { DateTimeField } from "@/components/ui/date-time-field";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { intakeToastOptions } from "@/components/medications/use-medication-intake";
import type { QueryKey } from "@tanstack/react-query";
import type { LedgerSchedule } from "@/components/medications/dose-history-ledger";

export interface LedgerAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  schedules: LedgerSchedule[];
  /** The Verlauf tab's ledger key so the add invalidates it alongside the
   * shared medication bundle. */
  ledgerKey: QueryKey;
}

/** The default on-time half-window in minutes (±1h, `DOSE_WINDOW_DEFAULTS`). A
 * take within this of a slot is an exact match (no nudge); past it but inside
 * the nudge ceiling triggers "diesem Slot zuordnen?". */
const ON_TIME_MINUTES = 60;
/** Past this gap a take is clearly its own ad-hoc event — no nudge. */
const NUDGE_CEILING_MINUTES = 240;

/** `<input type="datetime-local">` shape for a Date in local time. */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Distinct HH:mm slot times across the medication's schedules. */
function slotTimes(schedules: LedgerSchedule[]): string[] {
  const times = new Set<string>();
  for (const s of schedules) {
    if (s.timesOfDay && s.timesOfDay.length > 0) {
      for (const tod of s.timesOfDay) times.add(tod);
    } else if (s.windowStart) {
      times.add(s.windowStart);
    }
  }
  return Array.from(times).sort((a, b) => a.localeCompare(b));
}

/** The slot instant on the take's local day for an "HH:mm" slot. */
function slotInstantOnDay(takenAtLocal: string, slotHm: string): Date | null {
  const datePart = takenAtLocal.slice(0, 10);
  if (datePart.length !== 10) return null;
  const d = new Date(`${datePart}T${slotHm}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface NearestSlot {
  slotHm: string;
  instant: Date;
  gapMinutes: number;
}

/** The nearest schedule slot to the picked `takenAt` on its own day, with the
 * absolute gap in minutes. `null` when the medication has no time-anchored
 * slots (PRN) or the input is unparseable. */
export function nearestSlotForTake(
  takenAtLocal: string,
  times: string[],
): NearestSlot | null {
  const taken = new Date(takenAtLocal);
  if (Number.isNaN(taken.getTime())) return null;
  let best: NearestSlot | null = null;
  for (const slotHm of times) {
    const instant = slotInstantOnDay(takenAtLocal, slotHm);
    if (!instant) continue;
    const gapMinutes = Math.abs(instant.getTime() - taken.getTime()) / 60_000;
    if (!best || gapMinutes < best.gapMinutes) {
      best = { slotHm, instant, gapMinutes };
    }
  }
  return best;
}

/** Classify the take against its nearest slot: an exact in-window match pins
 * directly; a near-miss prompts the nudge; anything else records ad-hoc. */
export function classifyTake(
  nearest: NearestSlot | null,
): "exact" | "nudge" | "ad_hoc" {
  if (!nearest) return "ad_hoc";
  if (nearest.gapMinutes <= ON_TIME_MINUTES) return "exact";
  if (nearest.gapMinutes <= NUDGE_CEILING_MINUTES) return "nudge";
  return "ad_hoc";
}

export function LedgerAddDialog({
  open,
  onOpenChange,
  medicationId,
  medicationName,
  schedules,
  ledgerKey,
}: LedgerAddDialogProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // The record this dose lands in, or null in the caller's own.
  const recordName = useActiveRecordName();
  const formId = useId();

  const [takenAt, setTakenAt] = useState(() => toDateTimeLocal(new Date()));
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);

  const times = useMemo(() => slotTimes(schedules), [schedules]);
  const nearest = useMemo(
    () => (skipped ? null : nearestSlotForTake(takenAt, times)),
    [skipped, takenAt, times],
  );
  const classification = useMemo(() => classifyTake(nearest), [nearest]);

  /** Fire the write. `pin` true sends `forceSlotInstant` to bind the take onto
   * the nearest slot; false/exact uses `scheduledFor` for an in-window match,
   * else records ad-hoc. */
  async function write(pin: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { skipped };
      if (!skipped) body.takenAt = new Date(takenAt).toISOString();
      if (!skipped && nearest) {
        if (classification === "exact") {
          body.scheduledFor = nearest.instant.toISOString();
        } else if (pin) {
          body.forceSlotInstant = nearest.instant.toISOString();
        }
      }
      // A 422 here is the force-slot guard rejecting a non-slot instant;
      // apiPost throws so the catch below surfaces it rather than silently
      // dropping the dose.
      await apiPost(`/api/medications/${medicationId}/intake`, body);
      // v1.36.x — the shared decision. This surface offers no Undo, so what
      // it was missing is the other half: inside somebody else's record the
      // confirmation names the record, because "Taken" alone is the one
      // confirmation a person acting for somebody else does not need. The
      // ledger's "+ Eintrag" button that opens this dialog is gated on
      // `canWriteDomain("medications")`, so a delegate reaches it.
      const toastOptions = intakeToastOptions({
        recordName,
        eventId: undefined,
        t,
      });
      const message = t(
        skipped
          ? "medications.intakeToastSkipped"
          : "medications.intakeToastTaken",
        { name: medicationName },
      );
      if (toastOptions) {
        toast.success(message, toastOptions);
      } else {
        toast.success(message);
      }
      await invalidateKeys(queryClient, [
        ...medicationDependentKeys,
        ledgerKey,
      ]);
      // A ledger add can land a today-dated dose, so clear the unmounted
      // Today hero + dashboard too (v1.32.19 — same class as the ledger's
      // own log/edit/delete sites).
      await refetchInactiveDailyReads(queryClient);
      setNudgeOpen(false);
      onOpenChange(false);
    } catch {
      toast.error(t("medications.intakeToastFailed", { name: medicationName }));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    // A near-miss take prompts the slot-attribution nudge before writing;
    // everything else writes straight through.
    if (!skipped && classification === "nudge") {
      setNudgeOpen(true);
      return;
    }
    void write(false);
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={t("medications.detail.verlauf.addDialog.title")}
      description={t("medications.detail.verlauf.addDialog.description")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("medications.detail.verlauf.addDialog.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy}
            aria-busy={busy || undefined}
            data-slot="ledger-add-submit"
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("medications.detail.verlauf.addDialog.submit")}
          </Button>
        </>
      }
    >
      {/* v1.16.4 — a real form so Enter in the datetime field submits;
            the buttons carry explicit types so cancel never submits. */}
      <form
        id={formId}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="ledger-add-taken-at">
              {t("medications.detail.verlauf.addDialog.takenAtLabel")}
            </Label>
            <DateTimeField
              id="ledger-add-taken-at"
              value={takenAt}
              max={toDateTimeLocal(new Date())}
              onChange={(value) => setTakenAt(value)}
              disabled={skipped}
            />
          </div>

          <label
            htmlFor="ledger-add-skipped"
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm font-medium">
              {t("medications.detail.verlauf.addDialog.skippedLabel")}
            </span>
            <Switch
              id="ledger-add-skipped"
              checked={skipped}
              onCheckedChange={setSkipped}
            />
          </label>

          {/* A near-miss take previews where it will land before the user
              commits — calm, not alarming. */}
          {!skipped && classification === "nudge" && nearest && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="ledger-add-nudge-hint"
            >
              {t("medications.detail.verlauf.addDialog.nudgeHint", {
                slot: nearest.slotHm,
              })}
            </p>
          )}
        </div>
      </form>

      {/* The "diesem Slot zuordnen?" nudge — pin onto the slot, or keep the
            take as a standalone ad-hoc entry. */}
      {nudgeOpen && nearest && (
        <ResponsiveSheet
          open={nudgeOpen}
          onOpenChange={(o) => !busy && setNudgeOpen(o)}
          title={t("medications.detail.verlauf.nudge.title")}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => void write(false)}
                disabled={busy}
                data-slot="ledger-add-nudge-adhoc"
              >
                {t("medications.detail.verlauf.nudge.keepAdHoc")}
              </Button>
              <Button
                onClick={() => void write(true)}
                disabled={busy}
                aria-busy={busy || undefined}
                data-slot="ledger-add-nudge-pin"
              >
                {busy && (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {t("medications.detail.verlauf.nudge.pin")}
              </Button>
            </>
          }
        >
          <p className="text-muted-foreground text-sm">
            {t("medications.detail.verlauf.nudge.body", {
              slot: nearest.slotHm,
            })}
          </p>
        </ResponsiveSheet>
      )}
    </ResponsiveSheet>
  );
}
