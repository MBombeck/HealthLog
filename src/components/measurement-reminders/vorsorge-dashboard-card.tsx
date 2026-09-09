"use client";

/**
 * v1.18.2 — Vorsorge (preventive-care) dashboard summary card.
 *
 * A compact chart-row card listing the next few due reminders with an
 * inline primary action per row — the same done-vs-capture branch the
 * dedicated `/checkups` page surfaces, scaled down for the dashboard.
 * A free-text / self-planned exam marks done silently; a measurement-
 * linked reminder opens the real measurement-entry form and satisfies
 * the reminder in the same action.
 *
 * Mirrors the medication compliance card's role on the chart row:
 * chart-row only, no strip tile. Self-skeletons while the read is in
 * flight and self-gates to a brief empty state otherwise.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Plus } from "lucide-react";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useEncounters } from "@/hooks/use-encounters";
import {
  useFormatters,
  useTranslations,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ListRow } from "@/components/ui/list-row";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { isScreeningReminderType } from "@/lib/validations/measurement-reminders";
import { relativeDueKey } from "@/lib/measurement-reminders/due-day";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

const SUMMARY_LIMIT = 3;

/**
 * How far ahead an appointment has to be before this card stops mentioning it.
 *
 * A dashboard summary answers "what is coming", and two weeks is the horizon a
 * person plans in. Further out and the line is noise that pushes the checkups
 * it sits under off the card.
 */
const APPOINTMENT_HORIZON_DAYS = 14;

function resolveLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

export function VorsorgeDashboardCard() {
  const { t } = useTranslations();
  // Issue #490 — the same profile zone the checkups page derives its due
  // phrase in, so the two screens still agree when the device sits elsewhere.
  const displayTz = useDisplayTimezone();
  const format = useFormatters();
  const router = useRouter();
  // The same answer `/checkups` gives the same action. Satisfying a reminder
  // is not one of the verbs a delegation admits at any level
  // (`POST /api/measurement-reminders/[id]/satisfy` resolves the caller), and
  // the dashboard summary offering what the dedicated page withholds was the
  // tell that this row had never been asked.
  const { canManageDomain } = useRecordCapabilities();
  const canManageMeasurements = canManageDomain("measurements");
  const { data: reminders, isError, refetch } = useMeasurementReminders();

  // A query's `isLoading` is not a hydration-safe branch: TanStack reports the
  // optimistic mount fetch on the client's very first render and cannot on the
  // server, so an `isLoading` gate renders one thing in the streamed HTML and
  // another in the hydration render — React #418, and the whole streamed
  // dashboard is discarded. Gate on what both sides can see instead: whether
  // the cell holds an answer yet.
  const showLoading = !reminders && !isError;
  const { satisfy } = useMeasurementReminderMutations();
  const [now] = useState(() => Date.now());

  /**
   * The next appointment, read from the VISIT list and never from the reminder
   * table.
   *
   * An ENCOUNTER-origin reminder is excluded from every preventive-care read,
   * which is correct — an appointment is not a checkup, and relaxing that
   * filter here would put one in the due list. But a notification about
   * something invisible in the app is worse than no notification, so the
   * appointment appears where a person looks, sourced from the record it
   * actually lives in. A diff in this file that touches `origin` is the wrong
   * fix.
   */
  const visits = useEncounters();
  const nextAppointment = (visits.data?.upcoming ?? []).find(
    (visit) =>
      visit.status === "PLANNED" &&
      new Date(visit.occurredAt).getTime() - now <=
        APPOINTMENT_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  );
  const [capturing, setCapturing] = useState<MeasurementReminder | null>(null);
  const [captureFooterEl, setCaptureFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Active reminders only (the manage toggles hide disabled ones from the
  // summary), most-urgent first as the API already sorts them.
  const upcoming = (reminders ?? [])
    .filter((r) => r.enabled)
    .slice(0, SUMMARY_LIMIT);

  // v1.27.6 — a screening reminder routes to the check-in page (a score is
  // never typed in); completing the test auto-satisfies the reminder.
  function onPrimaryAction(reminder: MeasurementReminder) {
    if (isScreeningReminderType(reminder.measurementType)) {
      router.push("/mental-wellbeing");
    } else if (reminder.measurementType) {
      setCapturing(reminder);
    } else {
      satisfy.mutate(reminder.id);
    }
  }

  function onCaptureSuccess() {
    const reminder = capturing;
    setCapturing(null);
    if (reminder) satisfy.mutate(reminder.id);
  }

  return (
    <Card data-slot="vorsorge-dashboard-card" className="h-full">
      <CardHeader>
        <TileHeader
          size="sm"
          icon={CalendarClock}
          title={t("measurementReminders.sectionTitle")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {showLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : isError ? (
          // A read failure must not read as "no upcoming reminders" — a missed
          // checkup is the harm behind that fall-through (§6).
          <QueryErrorRow onRetry={() => refetch()} />
        ) : upcoming.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              {t("measurementReminders.dashboard.empty")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/checkups">
                {t("measurementReminders.dashboard.openLink")}
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((reminder) => {
              const due = relativeDueKey(reminder.nextDueAt, now, displayTz);
              const isLinked = reminder.measurementType != null;
              const isScreening = isScreeningReminderType(
                reminder.measurementType,
              );
              return (
                <ListRow
                  key={reminder.id}
                  asChild
                  className="flex items-center justify-between gap-3"
                >
                  <li>
                    <div className="min-w-0 space-y-1">
                      <p className="truncate text-sm font-medium">
                        {resolveLabel(reminder, t)}
                      </p>
                      <Badge variant="secondary" className="text-xs">
                        {t(due.key, {
                          days: due.days,
                        })}
                      </Badge>
                    </div>
                    {canManageMeasurements ? (
                      <Button
                        type="button"
                        size="default"
                        className="min-h-11 shrink-0 sm:min-h-9"
                        onClick={() => onPrimaryAction(reminder)}
                        disabled={satisfy.isPending}
                      >
                        {isLinked ? (
                          <>
                            <Plus className="h-4 w-4" />
                            {t(
                              isScreening
                                ? "measurementReminders.startCheckIn"
                                : "measurementReminders.captureValue",
                            )}
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-4 w-4" />
                            {t("measurementReminders.markDone")}
                          </>
                        )}
                      </Button>
                    ) : null}
                  </li>
                </ListRow>
              );
            })}
          </ul>
        )}

        {/* Visually distinct from a due checkup: a quiet line under the block
            rather than a fourth row with an action, because there is nothing
            to do about an appointment except keep it. */}
        {nextAppointment ? (
          <Link
            href="/checkups"
            data-slot="vorsorge-dashboard-next-visit"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-md border-t pt-2 text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
          >
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {t("encounters.dashboard.nextVisit", {
                what:
                  nextAppointment.practitioner?.name ??
                  encounterKindText(t, nextAppointment.kind as EncounterKind),
                when: format.date(nextAppointment.occurredAt),
              })}
            </span>
          </Link>
        ) : null}
      </CardContent>

      <ResponsiveSheet
        open={capturing !== null}
        onOpenChange={(open) => {
          if (!open) setCapturing(null);
        }}
        title={t("measurementReminders.capture.title")}
        description={t("measurementReminders.capture.description")}
        footer={<div ref={setCaptureFooterEl} className="flex w-full" />}
      >
        {capturing && (
          <MeasurementForm
            defaultType={capturing.measurementType ?? undefined}
            onSuccess={onCaptureSuccess}
            onCancel={() => setCapturing(null)}
            footerSlot={captureFooterEl}
          />
        )}
      </ResponsiveSheet>
    </Card>
  );
}
