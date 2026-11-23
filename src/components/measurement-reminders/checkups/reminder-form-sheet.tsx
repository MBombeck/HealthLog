"use client";

import type { Dispatch, SetStateAction } from "react";

import { FieldGroup } from "@/components/ui/field-group";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { isScreeningReminderType } from "@/lib/measurement-reminders/screening";

import {
  CADENCE_CUSTOM,
  CADENCE_RRULE,
  INTERVAL_PRESETS,
  MENTAL_SCREENING_DEFAULT_INTERVAL,
  TYPE_GROUPS,
  type FormState,
} from "./reminder-form";

/**
 * The create / edit sheet: label, kind, measurement type, cadence (preset,
 * free interval or RRULE), notification hour, first due date and location.
 */
export function ReminderFormSheet({
  open,
  isEdit,
  form,
  setForm,
  dirty,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  isEdit: boolean;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  /** The form differs from what it opened with. */
  dirty: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslations();
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      dirty={dirty}
      title={t(
        isEdit
          ? "measurementReminders.form.editTitle"
          : "measurementReminders.form.createTitle",
      )}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={!form.label.trim() || saving}
          >
            {t("measurementReminders.form.save")}
          </Button>
        </>
      }
    >
      {/* The cadence/type/hour pickers use NativeSelect (not the
          Radix Select labs/illness use) deliberately: these are long,
          grouped, scalar option lists where the OS-native picker is faster
          on touch and avoids a tall scrolling Radix popover inside the
          bottom-sheet. The form fields stay NativeSelect by design. */}
      <div className="space-y-4">
        <FieldGroup
          htmlFor="vorsorge-label"
          label={t("measurementReminders.form.label")}
        >
          <Input
            id="vorsorge-label"
            value={form.label}
            maxLength={120}
            placeholder={t("measurementReminders.form.labelPlaceholder")}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          />
        </FieldGroup>

        <FieldGroup
          htmlFor="vorsorge-kind"
          label={t("measurementReminders.form.kind")}
        >
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
        </FieldGroup>

        {form.kind === "type" && (
          <FieldGroup
            htmlFor="vorsorge-type"
            label={t("measurementReminders.form.measurementType")}
          >
            <NativeSelect
              id="vorsorge-type"
              value={form.measurementType}
              onChange={(e) => {
                const nextType = e.target.value;
                setForm((f) => ({
                  ...f,
                  measurementType: nextType,
                  // A screening covers the last two weeks, so
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
          </FieldGroup>
        )}

        <CadenceFields form={form} setForm={setForm} />

        <FieldGroup
          htmlFor="vorsorge-anchor"
          label={t("measurementReminders.form.firstDue")}
        >
          <DateField
            id="vorsorge-anchor"
            value={form.anchorDate}
            onChange={(value) => setForm((f) => ({ ...f, anchorDate: value }))}
          />
        </FieldGroup>

        <FieldGroup
          htmlFor="vorsorge-location"
          label={t("measurementReminders.form.location")}
        >
          <Input
            id="vorsorge-location"
            value={form.location}
            maxLength={200}
            placeholder={t("measurementReminders.form.locationPlaceholder")}
            onChange={(e) =>
              setForm((f) => ({ ...f, location: e.target.value }))
            }
          />
        </FieldGroup>
      </div>
    </ResponsiveSheet>
  );
}

/**
 * The cadence (preset, free interval or RRULE) and the notification hour.
 * The pickers are native selects on purpose: long, grouped scalar lists where
 * the system picker is faster on touch than a tall popover inside a sheet.
 */
function CadenceFields({
  form,
  setForm,
}: {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
}) {
  const { t } = useTranslations();
  const cadenceCustom = form.cadenceChoice === CADENCE_CUSTOM;
  const cadenceRrule = form.cadenceChoice === CADENCE_RRULE;
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <FieldGroup
          htmlFor="vorsorge-interval"
          label={t("measurementReminders.form.cadence")}
        >
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
        </FieldGroup>
        <FieldGroup
          htmlFor="vorsorge-hour"
          label={t("measurementReminders.form.notifyHour")}
        >
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
        </FieldGroup>
      </div>

      {cadenceCustom && (
        <FieldGroup
          htmlFor="vorsorge-custom-interval"
          label={t("measurementReminders.form.customInterval")}
        >
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
        </FieldGroup>
      )}

      {cadenceRrule && (
        <FieldGroup
          htmlFor="vorsorge-rrule"
          label={t("measurementReminders.form.rrule")}
        >
          <Input
            id="vorsorge-rrule"
            value={form.rrule}
            maxLength={512}
            placeholder="FREQ=YEARLY"
            onChange={(e) => setForm((f) => ({ ...f, rrule: e.target.value }))}
          />
          <p className="text-muted-foreground text-xs">
            {t("measurementReminders.form.rruleHint")}
          </p>
        </FieldGroup>
      )}
    </>
  );
}
