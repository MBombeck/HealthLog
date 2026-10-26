"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Plus, Wrench } from "lucide-react";

import { EncounterSheet } from "@/components/encounters/encounter-sheet";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useMeasurementReminderMutations,
  useMeasurementReminders,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTranslations } from "@/lib/i18n/context";
import { changedReminderFields } from "@/lib/measurement-reminders/edit-body";
import { isScreeningReminderType } from "@/lib/measurement-reminders/screening";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";

import { VorsorgeCard } from "./checkups/checkup-card";
import {
  EMPTY_FORM,
  formFromReminder,
  toEditBody,
  type FormState,
} from "./checkups/reminder-form";
import { ReminderFormSheet } from "./checkups/reminder-form-sheet";

/**
 * The checkups surface (the `/checkups` page and its settings card): the
 * reminder list, the create / edit sheet, the value capture that completes a
 * typed reminder with a real reading, and filing a visit against one. The
 * form, the card and the postpone sheet live in `./checkups/`.
 */
export function VorsorgeSection({
  enabled = true,
  variant = "settings",
}: {
  enabled?: boolean;
  /**
   * `"settings"` renders the compact `SettingsCardHeader` for the embedded
   * settings card; `"page"` renders the canonical feature-page header
   * (`<h1>` + subtitle + primary add button + wrench) so the standalone
   * `/vorsorge` surface matches its peers (labs, mood, medications, cycle).
   */
  variant?: "settings" | "page";
}) {
  const { t } = useTranslations();
  const { canManageDomain, inSharedRecord } = useRecordCapabilities();
  const canManageMeasurements = canManageDomain("measurements");
  const router = useRouter();
  const {
    data: reminders,
    isLoading,
    isError,
    error,
    refetch,
  } = useMeasurementReminders(enabled);
  const { create, update, remove, satisfy, skip, snooze } =
    useMeasurementReminderMutations();
  // Page view (cards/list) + manual order persist
  // client-side; the settings page writes them, the page reads them.
  const { prefs } = useModuleListPrefs("vorsorge");

  // `null` = sheet closed; "new" = create; a reminder = edit pre-filled.
  const [editing, setEditing] = useState<MeasurementReminder | "new" | null>(
    null,
  );
  /**
   * The due checkup a visit is being filed against, if any.
   *
   * The visit sheet does the rest: saving it as DONE satisfies this reminder
   * through the server's forward-only, idempotent path, so filing a visit AND
   * ticking the box is one satisfaction rather than an error.
   */
  const [visitForReminder, setVisitForReminder] = useState<string | null>(null);
  const [visitSession, setVisitSession] = useState(0);
  const openVisitFor = (reminder: MeasurementReminder) => {
    setVisitForReminder(reminder.id);
    setVisitSession((n) => n + 1);
  };
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // The form as it opened, so an edit sends only what changed.
  const [initialForm, setInitialForm] = useState<FormState>(EMPTY_FORM);
  // The value-capture sheet: holds the reminder whose measurement we are
  // entering. Non-null ⇒ the MeasurementForm sheet is open for that row.
  const [capturing, setCapturing] = useState<MeasurementReminder | null>(null);
  const [captureFooterEl, setCaptureFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Wall-clock anchor for the relative-due labels, captured once at mount
  // via a lazy state initializer so the impure Date.now() stays out of
  // render. The relative labels are coarse (day granularity), so a
  // mount-time snapshot is plenty fresh.
  const [now] = useState(() => Date.now());

  const sheetOpen = editing !== null;
  const isEdit = editing !== null && editing !== "new";

  function openCreate() {
    setForm(EMPTY_FORM);
    setEditing("new");
  }

  function openEdit(reminder: MeasurementReminder) {
    const opened = formFromReminder(reminder, t);
    setForm(opened);
    setInitialForm(opened);
    setEditing(reminder);
  }

  function closeSheet() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  function submit() {
    const trimmed = form.label.trim();
    if (!trimmed) return;
    const body = toEditBody(form);
    if (isEdit) {
      // Only what changed: an untouched first due date resent as local
      // midnight used to read as a new one and move an overdue check-up on.
      update.mutate(
        {
          id: (editing as MeasurementReminder).id,
          body: changedReminderFields(toEditBody(initialForm), body),
        },
        { onSuccess: closeSheet },
      );
    } else {
      create.mutate(body, { onSuccess: closeSheet });
    }
  }

  // The mark-done action. A free-text / self-planned exam satisfies
  // silently; a measurement-linked reminder opens the real value-entry
  // form so the user logs an actual reading. A screening reminder
  // Routes to the check-in page instead — the score is never
  // typed in, it falls out of a completed test, which then auto-satisfies
  // the reminder through the eventful worker.
  function onPrimaryAction(reminder: MeasurementReminder) {
    if (isScreeningReminderType(reminder.measurementType)) {
      router.push("/mental-wellbeing");
    } else if (reminder.measurementType) {
      setCapturing(reminder);
    } else {
      satisfy.mutate(reminder.id);
    }
  }

  // On a successful measurement write, satisfy the reminder in the same
  // user action (forward-only guard makes the later cron a no-op) and
  // close the sheet.
  function onCaptureSuccess() {
    const reminder = capturing;
    setCapturing(null);
    if (reminder) satisfy.mutate(reminder.id);
  }

  const saving = create.isPending || update.isPending;

  // The primary add affordance reads "hinzufügen" like
  // every other module's add button.
  // .x — a checkup reminder belongs to the person whose schedule it is,
  // and no grant level admits creating, editing or satisfying one. Inside
  // somebody else's record the schedule stays readable and every control that
  // would change it is absent.
  const addButton = canManageMeasurements ? (
    <Button
      type="button"
      className="min-h-11 shrink-0 sm:min-h-9"
      onClick={openCreate}
    >
      <Plus className="h-4 w-4" />
      {t("common.add")}
    </Button>
  ) : null;

  // The wrench links to the Vorsorge settings page (view,
  // reorder, per-reminder enable toggles), left of the Add button — the
  // canonical medication-page pattern. The old kebab "Anpassen" sheet is
  // gone (MOD-07); its toggles moved to the settings page. `/settings` is the
  // caller's, not the record's, so no grant reaches it.
  const wrenchButton = !inSharedRecord ? (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
    >
      <Link
        href="/settings/layout/vorsorge"
        aria-label={t("measurementReminders.customize")}
        title={t("measurementReminders.customize")}
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
      </Link>
    </Button>
  ) : null;

  return (
    <section aria-labelledby="vorsorge-section-title" className="space-y-4">
      {variant === "page" ? (
        <PageHeader
          titleId="vorsorge-section-title"
          title={
            <span data-tour-id="vorsorge-hero">
              {t("measurementReminders.sectionTitle")}
            </span>
          }
          description={t("measurementReminders.sectionDescription")}
          actions={
            <>
              {wrenchButton}
              {/* The empty state carries the add action while there is
                  nothing to list. */}
              {!isLoading && !isError && (reminders?.length ?? 0) === 0
                ? null
                : addButton}
            </>
          }
        />
      ) : null}
      {variant === "page" && !inSharedRecord ? (
        // The reminder switches and the screening hints moved out of the
        // checkups settings in v1.44 (Notifications, Health profile); both
        // stay one tap away from the page they are about.
        <div
          className="flex flex-wrap gap-2"
          data-slot="vorsorge-settings-links"
        >
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
          >
            <Link href="/settings/notifications#vorsorge-reminders">
              {t("notifications.checkupReminders.title")}
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
          >
            <Link href="/settings/anamnesis#screening-hints">
              {t("records.life.screening.cardTitle")}
            </Link>
          </Button>
        </div>
      ) : null}
      {variant === "page" ? null : (
        <SettingsCardHeader
          icon={CalendarClock}
          titleId="vorsorge-section-title"
          title={t("measurementReminders.sectionTitle")}
          description={t("measurementReminders.sectionDescription")}
          status={addButton}
        />
      )}

      <ReminderFormSheet
        open={sheetOpen}
        isEdit={isEdit}
        form={form}
        setForm={setForm}
        saving={saving}
        onClose={closeSheet}
        onSubmit={submit}
      />

      {/* Value-capture sheet: a measurement-linked reminder opens
          the real MeasurementForm pre-filled with its type, so completing a
          BP reminder logs an actual reading. On success the reminder is
          satisfied in the same action. */}
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

      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2" data-slot="vorsorge-loading">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} aria-hidden="true" className="h-full gap-3">
              <CardContent className="space-y-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-11 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && isError && (
        <QueryErrorRow
          error={error}
          message={t("measurementReminders.loadError")}
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !isError && (reminders?.length ?? 0) === 0 && (
        <EmptyState
          icon={<Plus className="size-6" />}
          title={t("measurementReminders.empty.title")}
          description={t("measurementReminders.empty.description")}
          action={
            canManageMeasurements ? (
              <Button type="button" onClick={openCreate}>
                {t("common.add")}
              </Button>
            ) : undefined
          }
        />
      )}

      {!isLoading && (reminders?.length ?? 0) > 0 && (
        <ul
          className={
            prefs.view === "list"
              ? "list-none space-y-2 p-0"
              : "grid list-none gap-4 p-0 sm:grid-cols-2"
          }
        >
          {applyOrder(reminders ?? [], prefs.order, (r) => r.id).map(
            (reminder) => (
              <li key={reminder.id} className="contents">
                <VorsorgeCard
                  reminder={reminder}
                  now={now}
                  view={prefs.view}
                  onPrimaryAction={() => onPrimaryAction(reminder)}
                  onFileVisit={() => openVisitFor(reminder)}
                  onRemove={() => remove.mutate(reminder.id)}
                  onEdit={() => openEdit(reminder)}
                  onSkip={() => skip.mutate(reminder.id)}
                  onSnooze={(until) =>
                    snooze.mutate({ id: reminder.id, until })
                  }
                  busy={
                    satisfy.isPending ||
                    remove.isPending ||
                    update.isPending ||
                    skip.isPending ||
                    snooze.isPending
                  }
                />
              </li>
            ),
          )}
        </ul>
      )}
      <EncounterSheet
        key={visitSession}
        open={visitForReminder !== null}
        onOpenChange={(open) => {
          if (!open) setVisitForReminder(null);
        }}
        encounter={null}
        reminderId={visitForReminder}
        // The reminder list repaints from the encounter write's own
        // invalidation; nothing extra to do here.
        onSaved={() => setVisitForReminder(null)}
      />
    </section>
  );
}
