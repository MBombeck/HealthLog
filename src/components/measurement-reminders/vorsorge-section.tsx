"use client";

/**
 * v1.17.1 — Vorsorge (preventive-care / measurement) reminder surface.
 *
 * Answers "wann muss ich was wo machen": a grid of upcoming reminders
 * sorted by server-computed next-due, each rendered as its OWN card that
 * mirrors the medication card grammar (neutral surface, header + kebab,
 * a next/last block, and a single bottom-pinned action). Per the project
 * rule the card stays NEUTRAL regardless of due state — no alarming
 * red/green tint; status reads through a discreet badge only.
 *
 * The server is authoritative for `nextDueAt`; this component renders it
 * relative to "now" but never recomputes the cadence.
 *
 * v1.18.2 — rebuilt to mirror the MEDICATION module:
 *   - each reminder is its own med-styled card (`VorsorgeCard`) reusing
 *     `MedicationCardHeader` / `MedicationNextLastSlot` and the
 *     `MedicationIntakeActions` bottom-pinned action treatment;
 *   - the mark-done action branches on `measurementType`: a free-text /
 *     self-planned exam keeps the silent satisfy ("Erledigt"); a
 *     measurement-linked reminder opens the real `MeasurementForm`
 *     ("Wert erfassen") so completing a BP reminder lands an actual
 *     reading, then satisfies the reminder in the same user action;
 *   - the create/edit form gains a first-due date (`anchorDate`) and a
 *     custom cadence (free "every N days" + an RFC-5545 RRULE option);
 *   - a wrench/customize affordance sits beside the page-variant Add,
 *     hosting the per-reminder enable/disable toggles (moved off the
 *     card so the card carries a single med-style kebab).
 */
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  Plus,
  Wrench,
} from "lucide-react";

import {
  useFormatters,
  useTranslations,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { relativeCalendarDate } from "@/lib/i18n/relative-time";
import { relativeDueKey } from "@/lib/measurement-reminders/due-day";
import { cn } from "@/lib/utils";
import { applyOrder, useModuleListPrefs } from "@/lib/module-list-prefs";
import { EncounterSheet } from "@/components/encounters/encounter-sheet";
import { SettingsCardHeader } from "@/components/settings/_card-header";
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
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LineChart, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { MeasurementForm } from "@/components/measurements/measurement-form";
import { MedicationCardHeader } from "@/components/medications/medication-card-header";
import { isScreeningReminderType } from "@/lib/validations/measurement-reminders";
import {
  useMeasurementReminders,
  useMeasurementReminderMutations,
  type MeasurementReminder,
} from "@/hooks/use-measurement-reminders";

// v1.18.1 (V3) — the active-measurement set, grouped so the dropdown
// doesn't read as a flat 15-item list. Mirrors the Zod allow-list in
// `validations/measurement-reminders.ts`; the labels resolve through
// `measurementReminders.types.*`, the group headers through
// `measurementReminders.typeGroups.*`.
const TYPE_GROUPS = [
  {
    group: "vitals",
    types: [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "PULSE",
      "BLOOD_GLUCOSE",
      "OXYGEN_SATURATION",
      "BODY_TEMPERATURE",
    ],
  },
  {
    group: "bodyComposition",
    types: [
      "BODY_FAT",
      "FAT_MASS",
      "FAT_FREE_MASS",
      "MUSCLE_MASS",
      "LEAN_BODY_MASS",
      "BONE_MASS",
      "TOTAL_BODY_WATER",
      "VISCERAL_FAT",
      "BODY_MASS_INDEX",
      "WAIST_CIRCUMFERENCE",
    ],
  },
  // v1.27.6 — the mental-wellbeing screenings become plannable like any
  // other Vorsorge item. Auto-resolve rides the server-written *_SCORE row a
  // completed check-in produces (v1.27.9 adds WHO-5 + SCI).
  {
    group: "mentalWellbeing",
    types: ["PHQ9_SCORE", "GAD7_SCORE", "WHO5_SCORE", "SCI_SCORE"],
  },
] as const;

// v1.27.6 — screening types get a dedicated primary action (the check-in
// page, not the numeric MeasurementForm) and a 4-week default cadence
// (both instruments cover the last two weeks).
const MENTAL_SCREENING_DEFAULT_INTERVAL = "28";

// 28 joined in v1.27.6 as the screening default (every 4 weeks); 30 stays
// so existing monthly reminders keep resolving onto a preset.
const INTERVAL_PRESETS = [7, 14, 28, 30, 90, 180, 365] as const;
// v1.18.2 — the sentinel the cadence picker writes when the user wants a
// free interval or an RFC-5545 RRULE instead of a fixed preset.
const CADENCE_CUSTOM = "custom";
const CADENCE_RRULE = "rrule";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1.18.1 — a COACH-minted reminder stores an i18n KEY in `label` (the
 * cadence preset's `labelKey`), not free prose. Resolve it through `t()`;
 * a user-created (VORSORGE) reminder carries free text and renders verbatim.
 */
function resolveReminderLabel(
  reminder: MeasurementReminder,
  t: (key: string) => string,
): string {
  if (reminder.origin === "COACH") {
    const translated = t(reminder.label);
    // `t()` echoes the key back on a miss; fall back to the raw value so a
    // future catalog addition never surfaces a bare key.
    return translated === reminder.label ? reminder.label : translated;
  }
  return reminder.label;
}

/** ISO instant → the `<input type="date">` value (YYYY-MM-DD), local. */
function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60 * 1000).toISOString().slice(0, 10);
}

/** `<input type="date">` value → an ISO instant at local midnight, or null. */
function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface FormState {
  label: string;
  kind: "type" | "freeText";
  measurementType: string;
  /** A preset number-as-string, or the CADENCE_CUSTOM / CADENCE_RRULE sentinel. */
  cadenceChoice: string;
  /** Free "every N days" value, used when cadenceChoice === CADENCE_CUSTOM. */
  customIntervalDays: number;
  /** Raw RRULE, used when cadenceChoice === CADENCE_RRULE. */
  rrule: string;
  /** First-due date (YYYY-MM-DD), optional. Maps to `anchorDate`. */
  anchorDate: string;
  notifyHour: number;
  location: string;
}

const EMPTY_FORM: FormState = {
  label: "",
  kind: "type",
  measurementType: "BLOOD_PRESSURE_SYS",
  cadenceChoice: "7",
  customIntervalDays: 30,
  rrule: "FREQ=YEARLY",
  anchorDate: "",
  notifyHour: 9,
  location: "",
};

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
    refetch,
  } = useMeasurementReminders(enabled);
  const { create, update, remove, satisfy, skip, snooze } =
    useMeasurementReminderMutations();
  // v1.18.6 (MOD-03) — page view (cards/list) + manual order persist
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
    // Resolve the stored cadence back onto the picker: a preset value if it
    // matches one, otherwise the custom-interval or RRULE branch.
    const interval = reminder.intervalDays;
    const cadenceChoice = reminder.rrule
      ? CADENCE_RRULE
      : interval != null &&
          (INTERVAL_PRESETS as readonly number[]).includes(interval)
        ? String(interval)
        : interval != null
          ? CADENCE_CUSTOM
          : "7";
    setForm({
      label: resolveReminderLabel(reminder, t),
      kind: reminder.measurementType ? "type" : "freeText",
      measurementType: reminder.measurementType ?? "BLOOD_PRESSURE_SYS",
      cadenceChoice,
      customIntervalDays:
        cadenceChoice === CADENCE_CUSTOM && interval != null ? interval : 30,
      rrule: reminder.rrule ?? "FREQ=YEARLY",
      anchorDate: toDateInputValue(reminder.anchorDate),
      notifyHour: reminder.notifyHour,
      location: reminder.location ?? "",
    });
    setEditing(reminder);
  }

  function closeSheet() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  // Resolve the picker state to the mutually-exclusive cadence pair the
  // schema expects (exactly one of intervalDays / rrule).
  function resolveCadence(): {
    intervalDays: number | null;
    rrule: string | null;
  } {
    if (form.cadenceChoice === CADENCE_RRULE) {
      const trimmed = form.rrule.trim();
      return { intervalDays: null, rrule: trimmed || null };
    }
    if (form.cadenceChoice === CADENCE_CUSTOM) {
      return { intervalDays: form.customIntervalDays, rrule: null };
    }
    return { intervalDays: Number(form.cadenceChoice), rrule: null };
  }

  function submit() {
    const trimmed = form.label.trim();
    if (!trimmed) return;
    const { intervalDays, rrule } = resolveCadence();
    const body = {
      label: trimmed,
      measurementType: form.kind === "type" ? form.measurementType : null,
      intervalDays,
      rrule,
      anchorDate: fromDateInputValue(form.anchorDate),
      notifyHour: form.notifyHour,
      location: form.location.trim() || null,
    };
    if (isEdit) {
      update.mutate(
        { id: (editing as MeasurementReminder).id, body },
        { onSuccess: closeSheet },
      );
    } else {
      create.mutate(body, { onSuccess: closeSheet });
    }
  }

  // The mark-done action. A free-text / self-planned exam satisfies
  // silently; a measurement-linked reminder opens the real value-entry
  // form so the user logs an actual reading. A screening reminder
  // (v1.27.6) routes to the check-in page instead — the score is never
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
  const cadenceCustom = form.cadenceChoice === CADENCE_CUSTOM;
  const cadenceRrule = form.cadenceChoice === CADENCE_RRULE;

  // v1.18.6 (MOD-02) — the primary add affordance reads "hinzufügen" like
  // every other module's add button.
  // v1.36.x — a checkup reminder belongs to the person whose schedule it is,
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

  // v1.18.6 (MOD-01) — the wrench links to the Vorsorge settings page (view,
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
              {addButton}
            </>
          }
        />
      ) : (
        <SettingsCardHeader
          icon={CalendarClock}
          titleId="vorsorge-section-title"
          title={t("measurementReminders.sectionTitle")}
          description={t("measurementReminders.sectionDescription")}
          status={addButton}
        />
      )}

      <ResponsiveSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) closeSheet();
        }}
        title={t(
          isEdit
            ? "measurementReminders.form.editTitle"
            : "measurementReminders.form.createTitle",
        )}
        description={t("measurementReminders.sectionDescription")}
        footer={
          <>
            <Button type="button" variant="outline" onClick={closeSheet}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={!form.label.trim() || saving}
            >
              {t("measurementReminders.form.save")}
            </Button>
          </>
        }
      >
        {/* v1.18.1 — the cadence/type/hour pickers use NativeSelect (not the
            Radix Select labs/illness use) deliberately: these are long,
            grouped, scalar option lists where the OS-native picker is faster
            on touch and avoids a tall scrolling Radix popover inside the
            bottom-sheet. The form fields stay NativeSelect by design. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="vorsorge-label">
              {t("measurementReminders.form.label")}
            </Label>
            <Input
              id="vorsorge-label"
              value={form.label}
              maxLength={120}
              placeholder={t("measurementReminders.form.labelPlaceholder")}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vorsorge-kind">
              {t("measurementReminders.form.kind")}
            </Label>
            <NativeSelect
              id="vorsorge-kind"
              value={form.kind}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  kind: e.target.value as "type" | "freeText",
                }))
              }
            >
              <option value="type">
                {t("measurementReminders.form.kindType")}
              </option>
              <option value="freeText">
                {t("measurementReminders.form.kindFreeText")}
              </option>
            </NativeSelect>
          </div>

          {form.kind === "type" && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-type">
                {t("measurementReminders.form.measurementType")}
              </Label>
              <NativeSelect
                id="vorsorge-type"
                value={form.measurementType}
                onChange={(e) => {
                  const nextType = e.target.value;
                  setForm((f) => ({
                    ...f,
                    measurementType: nextType,
                    // v1.27.6 — a screening covers the last two weeks, so
                    // switching onto a screening type defaults the cadence
                    // to every 4 weeks (still freely changeable).
                    cadenceChoice: isScreeningReminderType(nextType)
                      ? MENTAL_SCREENING_DEFAULT_INTERVAL
                      : f.cadenceChoice,
                  }));
                }}
              >
                {TYPE_GROUPS.map(({ group, types }) => (
                  <optgroup
                    key={group}
                    label={t(`measurementReminders.typeGroups.${group}`)}
                  >
                    {types.map((type) => (
                      <option key={type} value={type}>
                        {t(`measurementReminders.types.${type}`)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="vorsorge-interval">
                {t("measurementReminders.form.cadence")}
              </Label>
              <NativeSelect
                id="vorsorge-interval"
                value={form.cadenceChoice}
                onChange={(e) =>
                  setForm((f) => ({ ...f, cadenceChoice: e.target.value }))
                }
              >
                {INTERVAL_PRESETS.map((days) => (
                  <option key={days} value={String(days)}>
                    {t("measurementReminders.cadence.everyNDays", { days })}
                  </option>
                ))}
                <option value={CADENCE_CUSTOM}>
                  {t("measurementReminders.cadence.customInterval")}
                </option>
                <option value={CADENCE_RRULE}>
                  {t("measurementReminders.cadence.rruleOption")}
                </option>
              </NativeSelect>
            </div>
            <div className="space-y-2">
              <Label htmlFor="vorsorge-hour">
                {t("measurementReminders.form.notifyHour")}
              </Label>
              <NativeSelect
                id="vorsorge-hour"
                value={String(form.notifyHour)}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notifyHour: Number(e.target.value) }))
                }
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {`${h.toString().padStart(2, "0")}:00`}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          {cadenceCustom && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-custom-interval">
                {t("measurementReminders.form.customInterval")}
              </Label>
              <Input
                id="vorsorge-custom-interval"
                type="number"
                min={1}
                max={3650}
                value={form.customIntervalDays}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    customIntervalDays: Number(e.target.value),
                  }))
                }
              />
            </div>
          )}

          {cadenceRrule && (
            <div className="space-y-2">
              <Label htmlFor="vorsorge-rrule">
                {t("measurementReminders.form.rrule")}
              </Label>
              <Input
                id="vorsorge-rrule"
                value={form.rrule}
                maxLength={512}
                placeholder="FREQ=YEARLY"
                onChange={(e) =>
                  setForm((f) => ({ ...f, rrule: e.target.value }))
                }
              />
              <p className="text-muted-foreground text-xs">
                {t("measurementReminders.form.rruleHint")}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="vorsorge-anchor">
              {t("measurementReminders.form.firstDue")}
            </Label>
            <DateField
              id="vorsorge-anchor"
              value={form.anchorDate}
              onChange={(value) =>
                setForm((f) => ({ ...f, anchorDate: value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="vorsorge-location">
              {t("measurementReminders.form.location")}
            </Label>
            <Input
              id="vorsorge-location"
              value={form.location}
              maxLength={200}
              placeholder={t("measurementReminders.form.locationPlaceholder")}
              onChange={(e) =>
                setForm((f) => ({ ...f, location: e.target.value }))
              }
            />
          </div>
        </div>
      </ResponsiveSheet>

      {/* v1.18.2 — value-capture sheet: a measurement-linked reminder opens
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

/**
 * v1.18.6 (MOD-06) — progress through the current interval toward the next
 * due date, as a 0–100 percentage. Honest "are we on track" gamification
 * that reuses the medication card's `Progress` building block without
 * fabricating a streak the reminder data cannot support: 100 % (or beyond)
 * means due/overdue now, lower means time still remains in the window.
 * Returns null when there is no interval to measure against (RRULE / unset).
 */
/** v1.37.20 (#223) — the offsets the postpone menu offers, in days. */
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
  const anchor = new Date(`${isoDayInTz(nowMs, tz)}T12:00:00.000Z`);
  return SNOOZE_CHIP_DAYS.map((days) => {
    const target = new Date(anchor);
    target.setUTCDate(target.getUTCDate() + days);
    return { days, date: target.toISOString().slice(0, 10) };
  });
}

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

function VorsorgeCard({
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
}: {
  reminder: MeasurementReminder;
  now: number;
  view: "cards" | "list";
  onPrimaryAction: () => void;
  /** Open the visit sheet with this checkup pre-filled, closing it on save. */
  onFileVisit: () => void;
  onRemove: () => void;
  onEdit: () => void;
  /** v1.37.20 (#223) — honest skip; the server restarts the interval. */
  onSkip: () => void;
  /** v1.37.20 (#223) — snooze to a calendar day (ISO YYYY-MM-DD). */
  onSnooze: (until: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { canManageDomain } = useRecordCapabilities();
  const canManageMeasurements = canManageDomain("measurements");
  // Issue #490 — day-boundary zone for the relative "today / yesterday"
  // bucket must match the zone `fmt.date` renders in (mirror → Berlin).
  // The next-due phrase reads off the SAME zone as the last-done date below
  // it; they used to disagree by a day for anyone whose device sat in another
  // zone from their profile.
  const displayTz = useDisplayTimezone();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // v1.37.20 (#223) — the postpone sheet (snooze quick-chips + date field,
  // with the honest-skip zone below) and the skip confirm inside it.
  const [postponeOpen, setPostponeOpen] = useState(false);
  const [snoozeDate, setSnoozeDate] = useState("");
  const [confirmSkip, setConfirmSkip] = useState(false);
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
  // v1.27.5 — due-ness never changes the ACTION BUTTON: it keeps one
  // constant look in every state (same rule as the medication card's
  // constant surface). Due / overdue reads only through the discreet
  // coloured next-due text + the adherence meta line below.
  // v1.27.6 — a screening reminder's action is "start the check-in" (it
  // routes to the check-in page), never the numeric value-entry wording.
  const isScreening = isScreeningReminderType(reminder.measurementType);
  const isDue =
    due.key === "measurementReminders.nextDue.today" ||
    due.key === "measurementReminders.overdueByDays";
  const progress = intervalProgress(reminder, now);

  // Category-style header badge: the measurement label, or "self-planned"
  // for a free-text exam — mirroring the medication card's class badge.
  const categoryLabel = isLinked
    ? t(`measurementReminders.types.${reminder.measurementType}`)
    : t("measurementReminders.selfPlanned");

  // v1.18.10 — the cadence reads as part of the METRIC ROW (the category
  // line), styled like the metric label itself — same muted weight/colour,
  // no shaded pill. The card heading stays clean (nothing beside it); the
  // cadence rides next to "Blutdruck" et al. via `metricMeta` below.
  const cadenceText = cadence || null;

  // v1.18.10 — a measurement-linked reminder's heading links to the
  // measurements history pre-filtered to its type (the same target the
  // "Messergebnisse anzeigen" kebab item uses). A free-text reminder has no
  // readings to show, so it stays a plain (non-linking) heading.
  const measurementsHref = isLinked
    ? `/measurements?type=${encodeURIComponent(reminder.measurementType as string)}`
    : undefined;

  // Provenance / disabled state badges keep their own row below the category.
  // Omit the row entirely when neither applies (don't render an empty band).
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

  // Single med-style kebab: Edit + Delete. The Delete item is the shared
  // confirm-on-delete control rendered as a full-width menu row.
  const headerActions = canManageMeasurements ? (
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
        {/* v1.37.20 (#223) put postpone in the kebab. It reads better beside
            the primary action, the way the medication card carries "taken"
            and "skipped" side by side, so it is a card button now — see
            `postponeButton` below. */}
        {/* v1.18.7 (Wave E) — jump to the measurements list pre-filtered to
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
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onSelect={() => setConfirmDelete(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("measurementReminders.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // The measure / mark-done action. One constant appearance in every state —
  // no due-driven tint, no label swap (v1.27.5 retired the former green
  // "do it now" wash; a button that changes colour by schedule state reads as
  // a different control). Due-ness is communicated by the discreet coloured
  // next-due text above.
  /**
   * "Termin eintragen" — the second way to close a checkup.
   *
   * Beside "erledigt" rather than instead of it, because the two answer
   * different questions: one says the thing happened, the other says WHERE it
   * happened and files the record of it. Saving the visit as DONE satisfies
   * this reminder through the same forward-only, idempotent primitive the
   * checkbox uses, so a person who does both gets one satisfaction and no
   * error.
   */
  // The file-visit action belongs only to a free-text reminder — a real
  // practice visit, where "you went" is recorded by filing a visit. A typed
  // reminder (Gewicht, Blutdruck, a screening check-in) is satisfied by a
  // reading or a check-in inside the app, so it carries no visit affordance.
  // `resolve.ts` states the same boundary server-side: an appointment reminder
  // is free-text by construction.
  const fileVisitButton =
    canManageMeasurements && !isLinked ? (
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

  // Postponing sits beside the primary action rather than inside the kebab,
  // the way the medication card carries "taken" and "skipped" as two buttons
  // on the card. Outline against the filled primary: the same pairing, and
  // the same rule as everything else in this bar — one constant look, never
  // tinted by how overdue the checkup is.
  const postponeButton = canManageMeasurements ? (
    <Button
      type="button"
      variant="outline"
      className="min-h-11"
      data-slot="vorsorge-postpone"
      onClick={() => setPostponeOpen(true)}
      disabled={busy}
    >
      <CalendarClock className="h-4 w-4" />
      {t("measurementReminders.postpone.menuItem")}
    </Button>
  ) : null;

  const primaryButton = canManageMeasurements ? (
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
  ) : null;

  const deleteDialog = (
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
  );

  // v1.37.20 (#223) — resolved skip/snooze state, clock comparisons only
  // (the DTO comment states the contract: the server resolves, the client
  // compares). Meta lines are muted text — never a card colour change.
  const isSnoozed =
    reminder.snoozedUntil != null &&
    new Date(reminder.snoozedUntil).getTime() > now;
  const isSkippedCycle =
    reminder.lastSkippedAt != null &&
    (reminder.lastSatisfiedAt == null ||
      new Date(reminder.lastSkippedAt).getTime() >
        new Date(reminder.lastSatisfiedAt).getTime());

  const closePostpone = () => {
    setPostponeOpen(false);
    setSnoozeDate("");
    setConfirmSkip(false);
  };
  const minSnoozeDate = isoDayInTz(now + DAY_MS, displayTz);

  const postponeSheet = (
    <ResponsiveSheet
      open={postponeOpen}
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
  );

  const skipConfirmDialog = (
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
  );

  // Muted meta lines shared by both branches: "pushed back until {date}" /
  // "skipped on {date}" (+ lifetime count once it says something). "Last
  // done" stays lastSatisfiedAt — a skip never reads as done.
  const skipSnoozeMeta =
    isSnoozed || isSkippedCycle ? (
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
    ) : null;

  // v1.18.6 (MOD-03) — compact list row variant.
  if (view === "list") {
    return (
      <>
        {/* Density lives on the Card (py-3 vs the default py-4 md:py-6);
            the content slot keeps its own px-4 md:px-6 contract. */}
        <Card className="py-3 md:py-3">
          <CardContent className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 text-sm">
                <span className="truncate font-medium">
                  {resolveReminderLabel(reminder, t)}
                </span>
              </div>
              {/* v1.18.10 — cadence rides on the metric line, styled like the
                  metric text (no shaded pill). */}
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                <span className="text-foreground">
                  {t(due.key, { days: due.days })}
                </span>
                <span>{categoryLabel}</span>
                {cadenceText ? <span>{cadenceText}</span> : null}
              </div>
              {skipSnoozeMeta}
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
                  onClick={() => setPostponeOpen(true)}
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
        {deleteDialog}
        {postponeSheet}
        {skipConfirmDialog}
      </>
    );
  }

  // Next/last block in the med-card grammar, but with MEASUREMENT wording
  // (MOD-06: never "Einnahme" / intake — a measurement is not an intake). The
  // "next" value carries the discreet neutral due badge; the "last" value is
  // the last satisfied date.
  // v1.18.9 (#39) — "zuletzt erledigt" reads as a RELATIVE date in the
  // medication-card grammar (today → "Heute", yesterday → "Gestern", else the
  // absolute date) through the shared `relativeCalendarDate` helper, reusing
  // the same `medications.today` / `medications.yesterday` keys the medication
  // card renders. Falls back to "—" when there is no last-done value.
  const lastValue = reminder.lastSatisfiedAt
    ? relativeCalendarDate(
        reminder.lastSatisfiedAt,
        t,
        (d) => fmt.date(d),
        displayTz,
      )
    : "—";

  // v1.18.9 (#39) — the next-due status reads as DISCREET COLOURED TEXT (never
  // a card-background tint): due today → green, overdue → orange, otherwise the
  // normal muted-resolved date. The card surface stays neutral per the house
  // rule; only this inline label carries the status hue.
  const dueIsToday = due.key === "measurementReminders.nextDue.today";
  const dueIsOverdue = due.key === "measurementReminders.overdueByDays";
  const nextLastSlot = (
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

  return (
    <>
      {/* NEUTRAL card — no status-driven colour anywhere on the surface or
          the action button. Due state reads only through the discreet
          coloured next-due text. Shares the medication card shell + tokens. */}
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
          {nextLastSlot}
          {skipSnoozeMeta}

          {/* v1.18.6 (MOD-06) — light gamification: progress through the
              current interval toward next-due, reusing the medication card's
              Progress building block. Honest "on track / due" signal without
              a fabricated streak; hidden for RRULE / unscheduled reminders. */}
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

          {/* Bottom-pinned action row: the primary action takes the width it
              can, postpone sits beside it at its natural size — the same
              two-button shape the medication card uses for taken / skipped. */}
          {primaryButton ? (
            <div className="mt-auto space-y-1.5 pt-0">
              <div className="flex gap-2">
                {primaryButton}
                {postponeButton}
              </div>
              {fileVisitButton}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {deleteDialog}
      {postponeSheet}
      {skipConfirmDialog}
    </>
  );
}
