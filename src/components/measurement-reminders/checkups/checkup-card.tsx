"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Activity,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  LineChart,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";

import { MedicationCardHeader } from "@/components/medications/medication-card-header";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import {
  useDisplayTimezone,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import {
  isOverdueDue,
  relativeDueKey,
} from "@/lib/measurement-reminders/due-day";
import { isScreeningReminderType } from "@/lib/measurement-reminders/screening";
import { cn } from "@/lib/utils";

import { CheckupPostponeSheet } from "./postpone-sheet";
import { DAY_MS, resolveReminderLabel } from "./reminder-form";

/**
 * Progress through the current interval toward the next due date, 0 to 100:
 * an honest "on track / due" signal without a fabricated streak. Null without
 * an interval to measure against (RRULE or unset).
 */
function intervalProgress(
  reminder: MeasurementReminder,
  now: number,
): number | null {
  if (reminder.intervalDays == null || reminder.nextDueAt == null) return null;
  const dueMs = new Date(reminder.nextDueAt).getTime();
  if (Number.isNaN(dueMs)) return null;
  const windowMs = reminder.intervalDays * DAY_MS;
  const startMs = dueMs - windowMs;
  const elapsed = now - startMs;
  return Math.max(0, Math.min(100, Math.round((elapsed / windowMs) * 100)));
}

interface CheckupCardProps {
  reminder: MeasurementReminder;
  now: number;
  view: "cards" | "list";
  onPrimaryAction: () => void;
  /** Open the visit sheet with this checkup pre-filled, closing it on save. */
  onFileVisit: () => void;
  onRemove: () => void;
  onEdit: () => void;
  /** An honest skip; the server restarts the interval. */
  onSkip: () => void;
  /** Snooze to a calendar day (ISO YYYY-MM-DD). */
  onSnooze: (until: string) => void;
  busy: boolean;
}

/** The owner's card menu: edit, the readings for a typed reminder, delete. */
function CheckupMenu({
  reminder,
  isLinked,
  busy,
  onEdit,
  onRequestDelete,
}: {
  reminder: MeasurementReminder;
  isLinked: boolean;
  busy: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
}) {
  const { t } = useTranslations();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          className="sm:size-10"
          aria-label={t("common.moreOptions")}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={onEdit} disabled={busy}>
          <Pencil className="mr-2 h-4 w-4" />
          {t("measurementReminders.edit")}
        </DropdownMenuItem>
        {/* Put postpone in the kebab. It reads better beside
            the primary action, the way the medication card carries "taken"
            and "skipped" side by side, so it is a card button now — see
            `postponeButton` below. */}
        {/* Jump to the measurements list pre-filtered to
            this reminder's type. Only for measurement-linked reminders; a
            free-text reminder has no readings to show. */}
        {isLinked && (
          <DropdownMenuItem asChild>
            <Link
              href={`/measurements?type=${encodeURIComponent(
                reminder.measurementType as string,
              )}`}
            >
              <LineChart className="mr-2 h-4 w-4" />
              {t("measurementReminders.showMeasurements")}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={onRequestDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("measurementReminders.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "Pushed back until …" / "skipped on …", muted, never a card colour. */
function SkipSnoozeMeta({
  reminder,
  isSnoozed,
  isSkippedCycle,
}: {
  reminder: MeasurementReminder;
  isSnoozed: boolean;
  isSkippedCycle: boolean;
}) {
  const fmt = useFormatters();
  const { t } = useTranslations();
  return (
    <div
      className="text-muted-foreground space-y-0.5 text-xs"
      data-slot="vorsorge-skip-snooze-meta"
    >
      {isSnoozed && reminder.snoozedUntil && (
        <p>
          {t("measurementReminders.snoozedUntil", {
            date: fmt.date(new Date(reminder.snoozedUntil)),
          })}
        </p>
      )}
      {isSkippedCycle && reminder.lastSkippedAt && (
        <p>
          {t("measurementReminders.skippedOn", {
            date: fmt.date(new Date(reminder.lastSkippedAt)),
          })}
          {reminder.skipCount > 1
            ? ` · ${t("measurementReminders.skipCount", {
                count: reminder.skipCount,
              })}`
            : null}
        </p>
      )}
    </div>
  );
}

/**
 * The next-due and last-done lines in the medication card's grammar, with
 * measurement wording (never "intake"). Next due is coloured text, never a
 * tint: today in success, overdue in warning. Last done reads relative
 * (today, yesterday, else the date), or a dash.
 */
function NextLastSlot({
  reminder,
  due,
  displayTz,
}: {
  reminder: MeasurementReminder;
  due: ReturnType<typeof relativeDueKey>;
  displayTz: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const lastValue = reminder.lastSatisfiedAt
    ? relativeCalendarDate(
        reminder.lastSatisfiedAt,
        t,
        (d) => fmt.date(d),
        displayTz,
      )
    : "—";
  const dueIsToday = due.key === "measurementReminders.nextDue.today";
  const dueIsOverdue = isOverdueDue(due);
  return (
    <div className="min-h-[2.75rem] space-y-1.5 text-sm">
      <div className="text-muted-foreground flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-shrink truncate font-medium">
          {t("measurementReminders.nextDueLabel")}
        </span>
        <span
          className={cn(
            "text-right",
            dueIsToday
              ? "text-success font-medium"
              : dueIsOverdue
                ? "text-warning font-medium"
                : "text-foreground",
          )}
        >
          {t(due.key, { days: due.days })}
        </span>
      </div>
      <div className="text-muted-foreground flex items-baseline justify-between gap-3">
        <span className="min-w-0 flex-shrink truncate font-medium">
          {t("measurementReminders.lastDoneLabel")}
        </span>
        <span className="text-foreground text-right">{lastValue}</span>
      </div>
    </div>
  );
}

/** The dense list variant of a checkup. */
function CheckupListRow({
  reminder,
  due,
  categoryLabel,
  cadenceText,
  meta,
  isLinked,
  isScreening,
  canManageMeasurements,
  busy,
  onPrimaryAction,
  onPostpone,
  onFileVisit,
  headerActions,
}: {
  reminder: MeasurementReminder;
  due: ReturnType<typeof relativeDueKey>;
  categoryLabel: string;
  cadenceText: string | null;
  meta: React.ReactNode;
  isLinked: boolean;
  isScreening: boolean;
  canManageMeasurements: boolean;
  busy: boolean;
  onPrimaryAction: () => void;
  onPostpone: () => void;
  onFileVisit: () => void;
  headerActions: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <Card className="py-3 md:py-3">
      <CardContent className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 text-sm">
            <span className="truncate font-medium">
              {resolveReminderLabel(reminder, t)}
            </span>
          </div>
          {/* Cadence rides on the metric line, styled like the
              metric text (no shaded pill). */}
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <span className="text-foreground">
              {t(due.key, { days: due.days })}
            </span>
            <span>{categoryLabel}</span>
            {cadenceText ? <span>{cadenceText}</span> : null}
          </div>
          {meta}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* The same gate the cards branch applies through
              `primaryButton`. The list branch used to inline its own
              ungated copy, and which branch a person sees is a per-browser
              preference that survives the switch — so the identical action
              was offered or withheld depending on a view toggle. */}
          {canManageMeasurements ? (
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={onPrimaryAction}
              disabled={busy}
            >
              {isLinked
                ? t(
                    isScreening
                      ? "measurementReminders.startCheckIn"
                      : "measurementReminders.measureNow",
                  )
                : t("measurementReminders.markDone")}
            </Button>
          ) : null}
          {/* Icon-only in the dense list, labelled in the cards branch —
              the same action either way, never one branch offering what
              the other withholds. */}
          {canManageMeasurements ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 sm:size-9"
              data-slot="vorsorge-postpone"
              aria-label={t("measurementReminders.postpone.menuItem")}
              title={t("measurementReminders.postpone.menuItem")}
              onClick={onPostpone}
              disabled={busy}
            >
              <CalendarClock className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          {/* Free-text reminders only: a typed / screening reminder has no
              practice visit behind it. */}
          {canManageMeasurements && !isLinked ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11 sm:size-9"
              data-slot="vorsorge-file-visit"
              aria-label={t("measurementReminders.fileVisit")}
              title={t("measurementReminders.fileVisit")}
              onClick={onFileVisit}
              disabled={busy}
            >
              <CalendarPlus className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          {headerActions}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The bottom-pinned action row (owner only): the primary action takes the
 * width it can, postpone sits beside it, as the medication card carries taken
 * and skipped; a free-text checkup adds "file a visit" below.
 */
function CheckupActionRow({
  isLinked,
  isScreening,
  busy,
  onPrimaryAction,
  onPostpone,
  onFileVisit,
}: {
  isLinked: boolean;
  isScreening: boolean;
  busy: boolean;
  onPrimaryAction: () => void;
  onPostpone: () => void;
  onFileVisit: () => void;
}) {
  const { t } = useTranslations();
  // "File a visit": the second way to close a checkup, beside "done". Only a
  // free-text reminder (a real practice visit) carries it; a typed one is
  // satisfied by a reading or a check-in. Saving the visit as DONE satisfies
  // the reminder through the same forward-only, idempotent path, so doing
  // both is one satisfaction.
  const fileVisitButton = !isLinked ? (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 w-full"
      data-slot="vorsorge-file-visit"
      onClick={onFileVisit}
      disabled={busy}
    >
      <CalendarPlus className="h-4 w-4" />
      {t("measurementReminders.fileVisit")}
    </Button>
  ) : null;

  // Postpone beside the primary action, outline against filled, as the
  // medication card carries taken and skipped.
  const postponeButton = (
    <Button
      type="button"
      variant="outline"
      className="min-h-11"
      data-slot="vorsorge-postpone"
      onClick={onPostpone}
      disabled={busy}
    >
      <CalendarClock className="h-4 w-4" />
      {t("measurementReminders.postpone.menuItem")}
    </Button>
  );

  const primaryButton = (
    <Button
      type="button"
      className="min-h-11 flex-1"
      onClick={onPrimaryAction}
      disabled={busy}
    >
      {isLinked ? (
        <>
          <Activity className="h-4 w-4" />
          {t(
            isScreening
              ? "measurementReminders.startCheckIn"
              : "measurementReminders.measureNow",
          )}
        </>
      ) : (
        <>
          <CheckCircle2 className="h-4 w-4" />
          {t("measurementReminders.markDone")}
        </>
      )}
    </Button>
  );

  return (
    <div className="mt-auto space-y-1.5 pt-0">
      <div className="flex gap-2">
        {primaryButton}
        {postponeButton}
      </div>
      {fileVisitButton}
    </div>
  );
}

/**
 * The card's body lines: progress through the interval (hidden for RRULE or
 * unscheduled reminders), the course end and the location.
 */
function CheckupDetails({
  reminder,
  progress,
  isDue,
}: {
  reminder: MeasurementReminder;
  progress: number | null;
  isDue: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <>
      {progress != null && (
        <div className="space-y-1">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>{t("measurementReminders.adherence.label")}</span>
            <span className="tabular-nums">
              {isDue
                ? t("measurementReminders.adherence.due")
                : t("measurementReminders.adherence.onTrack")}
            </span>
          </div>
          <Progress
            value={progress}
            aria-label={t("measurementReminders.adherence.label")}
          />
        </div>
      )}

      {reminder.endsOn && (
        <p className="text-muted-foreground text-sm">
          {/* `endsOn` is a real instant (`now + courseDays` at Coach
              accept, plain timestamptz — NOT a `@db.Date` UTC-midnight
              calendar date), so the profile-tz formatter renders the
              correct local course-end day for every zone. */}
          {t("measurementReminders.until", {
            date: fmt.date(new Date(reminder.endsOn)),
          })}
        </p>
      )}
      {reminder.location && (
        <p className="text-muted-foreground text-sm">
          {t("measurementReminders.location.prefix", {
            location: reminder.location,
          })}
        </p>
      )}
    </>
  );
}

export function VorsorgeCard({
  reminder,
  now,
  view,
  onPrimaryAction,
  onFileVisit,
  onRemove,
  onEdit,
  onSkip,
  onSnooze,
  busy,
}: CheckupCardProps) {
  const { t } = useTranslations();
  const { canManageDomain } = useRecordCapabilities();
  const canManageMeasurements = canManageDomain("measurements");
  // The relative "today / yesterday" bucket uses the zone `fmt.date` renders
  // in (#490), so the next-due phrase and the last-done date agree.
  const displayTz = useDisplayTimezone();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [postponeOpen, setPostponeOpen] = useState(false);
  const due = relativeDueKey(reminder.nextDueAt, now, displayTz);
  const cadence =
    reminder.intervalDays != null
      ? t("measurementReminders.cadence.everyNDays", {
          days: reminder.intervalDays,
        })
      : reminder.rrule
        ? t("measurementReminders.cadence.custom")
        : "";
  const isCoach = reminder.origin === "COACH";
  const isLinked = reminder.measurementType != null;
  // A screening reminder's action starts the check-in, never numeric entry.
  const isScreening = isScreeningReminderType(reminder.measurementType);
  const isDue =
    due.key === "measurementReminders.nextDue.today" || isOverdueDue(due);
  const progress = intervalProgress(reminder, now);

  // The category line: the measurement, or "self-planned" for a free-text
  // exam, with the cadence beside it in the same muted style.
  const categoryLabel = isLinked
    ? t(`measurementReminders.types.${reminder.measurementType}`)
    : t("measurementReminders.selfPlanned");
  const cadenceText = cadence || null;

  // A typed reminder's heading links to its readings; a free-text one has
  // none and stays a plain heading.
  const measurementsHref = isLinked
    ? `/measurements?type=${encodeURIComponent(reminder.measurementType as string)}`
    : undefined;

  // Provenance and disabled badges get a row only when one applies.
  const hasStateBadges = isCoach || !reminder.enabled;
  const stateBadges = hasStateBadges ? (
    <>
      {isCoach && (
        <Badge variant="outline">{t("measurementReminders.originCoach")}</Badge>
      )}
      {!reminder.enabled && (
        <Badge variant="outline">
          {t("measurementReminders.disabledBadge")}
        </Badge>
      )}
    </>
  ) : undefined;

  const headerActions = canManageMeasurements ? (
    <CheckupMenu
      reminder={reminder}
      isLinked={isLinked}
      busy={busy}
      onEdit={onEdit}
      onRequestDelete={() => setConfirmDelete(true)}
    />
  ) : null;

  const dialogs = (
    <>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("measurementReminders.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("measurementReminders.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onRemove}>
              {t("measurementReminders.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CheckupPostponeSheet
        reminder={reminder}
        now={now}
        open={postponeOpen}
        onClose={() => setPostponeOpen(false)}
        busy={busy}
        onSnooze={onSnooze}
        onSkip={onSkip}
      />
    </>
  );

  // The resolved skip and snooze state: clock comparisons only, since the
  // server resolves and the client compares.
  const isSnoozed =
    reminder.snoozedUntil != null &&
    new Date(reminder.snoozedUntil).getTime() > now;
  const isSkippedCycle =
    reminder.lastSkippedAt != null &&
    (reminder.lastSatisfiedAt == null ||
      new Date(reminder.lastSkippedAt).getTime() >
        new Date(reminder.lastSatisfiedAt).getTime());
  const skipSnoozeMeta =
    isSnoozed || isSkippedCycle ? (
      <SkipSnoozeMeta
        reminder={reminder}
        isSnoozed={isSnoozed}
        isSkippedCycle={isSkippedCycle}
      />
    ) : null;

  if (view === "list") {
    return (
      <>
        <CheckupListRow
          reminder={reminder}
          due={due}
          categoryLabel={categoryLabel}
          cadenceText={cadenceText}
          meta={skipSnoozeMeta}
          isLinked={isLinked}
          isScreening={isScreening}
          canManageMeasurements={canManageMeasurements}
          busy={busy}
          onPrimaryAction={onPrimaryAction}
          onPostpone={() => setPostponeOpen(true)}
          onFileVisit={onFileVisit}
          headerActions={headerActions}
        />
        {dialogs}
      </>
    );
  }

  return (
    <>
      <Card className="h-full gap-3 md:gap-3">
        <MedicationCardHeader
          name={resolveReminderLabel(reminder, t)}
          dose=""
          categoryLabel={categoryLabel}
          metricMeta={cadenceText}
          href={measurementsHref}
          linkLabel={
            measurementsHref
              ? t("measurementReminders.showMeasurements")
              : undefined
          }
          stateBadges={stateBadges}
          actions={headerActions}
        />
        <CardContent className="flex h-full flex-col space-y-3.5">
          <NextLastSlot reminder={reminder} due={due} displayTz={displayTz} />
          {skipSnoozeMeta}

          {/* Light gamification: progress through the
              current interval toward next-due, reusing the medication card's
              Progress building block. Honest "on track / due" signal without
              a fabricated streak; hidden for RRULE / unscheduled reminders. */}
          <CheckupDetails
            reminder={reminder}
            progress={progress}
            isDue={isDue}
          />

          {/* Bottom-pinned action row: the primary action takes the width it
              can, postpone sits beside it at its natural size — the same
              two-button shape the medication card uses for taken / skipped. */}
          {canManageMeasurements ? (
            <CheckupActionRow
              isLinked={isLinked}
              isScreening={isScreening}
              busy={busy}
              onPrimaryAction={onPrimaryAction}
              onPostpone={() => setPostponeOpen(true)}
              onFileVisit={onFileVisit}
            />
          ) : null}
        </CardContent>
      </Card>

      {dialogs}
    </>
  );
}
