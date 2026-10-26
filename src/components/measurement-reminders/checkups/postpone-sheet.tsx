"use client";

import { useState } from "react";

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
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
import { shiftDateKey } from "@/lib/tz/format";

import { DAY_MS } from "./reminder-form";

/** The offsets the postpone sheet's quick chips offer, in days. */
const SNOOZE_CHIP_DAYS = [7, 30, 90] as const;

/**
 * The local calendar day (ISO `yyyy-MM-dd`) an instant falls on in `tz`.
 * Snooze is day-precision by contract: the server resolves the day to the
 * reminder's notifyHour in the profile timezone.
 */
function isoDayInTz(atMs: number, tz: string): string {
  return new Date(atMs).toLocaleDateString("sv-SE", { timeZone: tz });
}

/**
 * The dates the postpone sheet's quick chips resolve to, on the display zone's
 * calendar.
 *
 * Its own function because a chip labelled "+7 days" has to write the day that
 * is actually seven days out, including across a DST shift, where adding
 * 7 × 86 400 000 ms lands an hour either side of midnight and so can write the
 * neighbouring date.
 */
export function postponeOffsetTargets(
  nowMs: number,
  tz: string,
): { days: number; date: string }[] {
  // Count days on the calendar, not in milliseconds: `now + 7 * DAY_MS` keeps
  // the wall-clock time only where the offset stays constant, and a DST shift
  // in between moves it an hour, which flips the date for anyone acting near
  // midnight. Anchoring today's local date at UTC noon and stepping whole
  // UTC days keeps every offset on the day its label names.
  const today = isoDayInTz(nowMs, tz);
  return SNOOZE_CHIP_DAYS.map((days) => ({
    days,
    date: shiftDateKey(today, days),
  }));
}

/**
 * The postpone sheet: quick chips and a date to push the checkup back to,
 * and set apart below them the honest skip (let this cycle go and restart
 * the rhythm) with its own confirmation.
 */
export function CheckupPostponeSheet({
  reminder,
  now,
  open,
  onClose,
  busy,
  onSnooze,
  onSkip,
}: {
  reminder: MeasurementReminder;
  now: number;
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onSnooze: (until: string) => void;
  onSkip: () => void;
}) {
  const { t } = useTranslations();
  // The day boundary follows the zone dates render in.
  const displayTz = useDisplayTimezone();
  const [snoozeDate, setSnoozeDate] = useState("");
  const [confirmSkip, setConfirmSkip] = useState(false);
  const closePostpone = () => {
    onClose();
    setSnoozeDate("");
    setConfirmSkip(false);
  };
  const minSnoozeDate = isoDayInTz(now + DAY_MS, displayTz);
  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={(open) => {
          if (!open) closePostpone();
        }}
        title={t("measurementReminders.postpone.title")}
        description={t("measurementReminders.postpone.description")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={closePostpone}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!snoozeDate || busy}
              onClick={() => {
                onSnooze(snoozeDate);
                closePostpone();
              }}
            >
              {t("measurementReminders.postpone.confirm")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {/* Quick chips write the date field rather than firing directly, so
              the person always sees (and can adjust) what will be sent. */}
          <div className="flex flex-wrap gap-2">
            {postponeOffsetTargets(now, displayTz).map(({ days, date }) => (
              <Button
                key={days}
                type="button"
                size="sm"
                variant={snoozeDate === date ? "secondary" : "outline"}
                onClick={() => setSnoozeDate(date)}
              >
                {t("measurementReminders.postpone.chip", { days })}
              </Button>
            ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`snooze-date-${reminder.id}`}>
              {t("measurementReminders.postpone.dateLabel")}
            </Label>
            <DateField
              id={`snooze-date-${reminder.id}`}
              value={snoozeDate}
              onChange={setSnoozeDate}
              min={minSnoozeDate}
            />
          </div>
          {/* The honest-skip zone sits set apart below the snooze controls:
              a different decision (let this cycle go, restart the rhythm)
              with its own confirm step. */}
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm font-medium">
              {t("measurementReminders.skip.heading")}
            </p>
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.skip.explainer")}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmSkip(true)}
              data-slot="vorsorge-skip"
            >
              {t("measurementReminders.skip.action")}
            </Button>
          </div>
        </div>
      </ResponsiveSheet>
      <AlertDialog open={confirmSkip} onOpenChange={setConfirmSkip}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("measurementReminders.skip.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("measurementReminders.skip.explainer")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onSkip();
                closePostpone();
              }}
            >
              {t("measurementReminders.skip.action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
