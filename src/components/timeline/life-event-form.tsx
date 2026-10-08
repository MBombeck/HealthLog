"use client";

/**
 * The life-event form (v1.42, #613): what happened, its kind, when (to the
 * day, the month or only the year), an optional end for a period, an
 * optional note. Title and note are encrypted at rest and go to no model;
 * the form says so in one line above the actions.
 *
 * Used in two places: the timeline's own sheet (add and edit) and the
 * capture picker's sheet, which hands it a footer slot so the actions sit in
 * the sheet's sticky footer like every other quick entry.
 */
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, Lock, Plus, Trash2, X } from "lucide-react";

import { FieldError } from "@/components/forms/field-error";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { localizedApiError } from "@/lib/api/localized-error";
import {
  LIFE_EVENT_CATEGORIES,
  LIFE_EVENT_PRECISIONS,
  LIFE_EVENT_TITLE_MAX,
  type LifeEventCategory,
  type LifeEventDTO,
  type LifeEventPrecision,
} from "@/lib/day/contract";
import { resolveIntlLocale } from "@/lib/format-locale";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import {
  createBody,
  draftFromEvent,
  emptyDraft,
  updateBody,
  validateDraft,
  withPrecision,
  type LifeEventDraft,
  type LifeEventDraftErrors,
} from "./life-event-draft";
import { Segmented } from "./segmented";
import { formatMonthLong, todayKeyIn } from "./timeline-dates";
import { useLifeEventMutations } from "./use-timeline";

export interface LifeEventFormProps {
  /** The event being edited, or null to add one. */
  event?: LifeEventDTO | null;
  /** Prefilled start for a new event (a day's capture sheet passes its day). */
  defaultDate?: string;
  onSuccess?: () => void;
  onCancel?: () => void;
  /** Where the action row goes; inline when absent. */
  footerSlot?: HTMLElement | null;
}

function CategoryChips({
  value,
  onChange,
  labelledBy,
  invalid,
}: {
  value: LifeEventCategory | null;
  onChange: (next: LifeEventCategory) => void;
  labelledBy: string;
  invalid: boolean;
}) {
  const { t } = useTranslations();
  const { getRadioProps } = useRovingRadioGroup({
    count: LIFE_EVENT_CATEGORIES.length,
    selectedIndex: value ? LIFE_EVENT_CATEGORIES.indexOf(value) : -1,
    onSelect: (index) => onChange(LIFE_EVENT_CATEGORIES[index]),
  });
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-invalid={invalid || undefined}
      className="flex flex-wrap gap-2"
      data-slot="life-event-category"
    >
      {LIFE_EVENT_CATEGORIES.map((category, index) => {
        const checked = value === category;
        return (
          <button
            key={category}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={category}
            onClick={() => onChange(category)}
            {...getRadioProps(index)}
            className={cn(
              "focus-visible:ring-ring/50 min-h-11 rounded-full border px-3.5 text-sm font-medium outline-none focus-visible:ring-2 sm:min-h-9",
              checked
                ? "bg-foreground text-background border-transparent"
                : "border-border text-foreground hover:bg-accent",
            )}
          >
            {t(`lifeEvents.category.${category}`)}
          </button>
        );
      })}
    </div>
  );
}

/** A date at the draft's precision: day field, month and year, or year. */
function PrecisionDate({
  id,
  value,
  precision,
  onChange,
  invalid,
  describedBy,
  today,
}: {
  id: string;
  value: string;
  precision: LifeEventPrecision;
  onChange: (next: string) => void;
  invalid: boolean;
  describedBy?: string;
  today: string;
}) {
  const { t, locale } = useTranslations();
  const intl = resolveIntlLocale(locale);
  const thisYear = Number(today.slice(0, 4));
  const years = Array.from(
    { length: thisYear + 2 - 1900 },
    (_, i) => thisYear + 1 - i,
  );
  const year = Number(value.slice(0, 4)) || thisYear;
  const month = Number(value.slice(5, 7)) || 1;
  const pad = (n: number) => String(n).padStart(2, "0");

  if (precision === "DAY") {
    return (
      <DateField
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    );
  }
  const yearSelect = (
    <NativeSelect
      id={precision === "YEAR" ? id : `${id}-year`}
      aria-label={t("lifeEvents.precision.YEAR")}
      value={String(year)}
      onChange={(e) =>
        onChange(
          precision === "YEAR"
            ? `${e.target.value}-01-01`
            : `${e.target.value}-${pad(month)}-01`,
        )
      }
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </NativeSelect>
  );
  if (precision === "YEAR") return yearSelect;
  return (
    <div className="grid grid-cols-[1fr_6.5rem] gap-2">
      <NativeSelect
        id={id}
        aria-label={t("lifeEvents.precision.MONTH")}
        value={String(month)}
        onChange={(e) => onChange(`${year}-${pad(Number(e.target.value))}-01`)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            {formatMonthLong(`2001-${pad(m)}-01`, intl)}
          </option>
        ))}
      </NativeSelect>
      {yearSelect}
    </div>
  );
}

export function LifeEventForm({
  event = null,
  defaultDate,
  onSuccess,
  onCancel,
  footerSlot,
}: LifeEventFormProps) {
  const { t } = useTranslations();
  const ids = {
    form: useId(),
    title: useId(),
    category: useId(),
    start: useId(),
    end: useId(),
    note: useId(),
  };
  const today = todayKeyIn(undefined);
  const [draft, setDraft] = useState<LifeEventDraft>(() =>
    event ? draftFromEvent(event) : emptyDraft(defaultDate ?? today),
  );
  const [errors, setErrors] = useState<LifeEventDraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const { create, update, remove } = useLifeEventMutations();
  const saving = create.isPending || update.isPending || remove.isPending;

  const set = <K extends keyof LifeEventDraft>(
    key: K,
    value: LifeEventDraft[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  const fieldError = (field: keyof LifeEventDraftErrors) =>
    errors[field] ? t(`lifeEvents.errors.${errors[field]}`) : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaveError(null);
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      if (event) {
        const body = updateBody(event, draft);
        if (Object.keys(body).length > 0) {
          await update.mutateAsync({ id: event.id, body });
        }
      } else {
        await create.mutateAsync(createBody(draft));
      }
      toastWrittenOutcome("success", t("lifeEvents.saved"));
      onSuccess?.();
    } catch (err) {
      setSaveError(localizedApiError(err, t, "lifeEvents.saveFailed"));
    }
  }

  async function destroy() {
    if (!event || saving) return;
    setSaveError(null);
    try {
      await remove.mutateAsync(event.id);
      toastWrittenOutcome("success", t("lifeEvents.deleted"));
      onSuccess?.();
    } catch (err) {
      setSaveError(localizedApiError(err, t, "lifeEvents.deleteFailed"));
    }
  }

  const footer = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {event && (
        <ConfirmButton
          label={t("lifeEvents.delete")}
          title={t("lifeEvents.deleteConfirm.title")}
          body={t("lifeEvents.deleteConfirm.body")}
          confirmLabel={t("lifeEvents.delete")}
          onConfirm={() => void destroy()}
          pending={remove.isPending}
          disabled={saving}
          size="sm"
          variant="destructive"
          className="mr-auto min-h-11 sm:min-h-9"
          icon={<Trash2 className="size-4" aria-hidden="true" />}
          slot="life-event-delete"
        />
      )}
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          onClick={onCancel}
          disabled={saving}
        >
          {t("lifeEvents.cancel")}
        </Button>
      )}
      <Button
        type="submit"
        form={ids.form}
        size="sm"
        className="min-h-11 sm:min-h-9"
        disabled={saving}
        data-slot="life-event-save"
      >
        {saving ? (
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : event ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Plus className="size-4" aria-hidden="true" />
        )}
        {t("lifeEvents.save")}
      </Button>
    </div>
  );

  return (
    <form
      id={ids.form}
      onSubmit={submit}
      noValidate
      className="space-y-4"
      data-slot="life-event-form"
    >
      <div className="space-y-2">
        <Label htmlFor={ids.title} noColon>
          {t("lifeEvents.fields.title")}
        </Label>
        <Input
          id={ids.title}
          value={draft.title}
          maxLength={LIFE_EVENT_TITLE_MAX}
          autoComplete="off"
          onChange={(e) => set("title", e.target.value)}
          aria-invalid={!!errors.title || undefined}
          aria-describedby={errors.title ? `${ids.title}-error` : undefined}
          data-slot="life-event-title"
        />
        <FieldError id={`${ids.title}-error`} message={fieldError("title")} />
      </div>

      <div className="space-y-2">
        <Label id={ids.category} noColon asChild>
          <span>{t("lifeEvents.fields.category")}</span>
        </Label>
        <CategoryChips
          value={draft.category}
          onChange={(c) => set("category", c)}
          labelledBy={ids.category}
          invalid={!!errors.category}
        />
        <FieldError
          id={`${ids.category}-error`}
          message={fieldError("category")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-2">
          <Label htmlFor={ids.start} noColon>
            {t("lifeEvents.fields.when")}
          </Label>
          <PrecisionDate
            id={ids.start}
            value={draft.start}
            precision={draft.precision}
            onChange={(v) => set("start", v)}
            invalid={!!errors.start}
            describedBy={errors.start ? `${ids.start}-error` : undefined}
            today={today}
          />
          <FieldError id={`${ids.start}-error`} message={fieldError("start")} />
        </div>
        <div className="space-y-2">
          <Label id={`${ids.start}-precision`} noColon asChild>
            <span>{t("lifeEvents.fields.precision")}</span>
          </Label>
          <Segmented
            options={LIFE_EVENT_PRECISIONS.map((p) => ({
              value: p,
              label: t(`lifeEvents.precision.${p}`),
            }))}
            value={draft.precision}
            onChange={(p) => setDraft((d) => withPrecision(d, p))}
            label={t("lifeEvents.fields.precision")}
            slot="life-event-precision"
            stretch
            asToggleButtons
          />
        </div>
      </div>

      {draft.end === null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 min-h-11 sm:min-h-9"
          onClick={() => set("end", draft.start)}
          data-slot="life-event-add-end"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t("lifeEvents.fields.addEnd")}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={ids.end} noColon>
              {t("lifeEvents.fields.endDate")}
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-mr-2 min-h-11 sm:min-h-8"
              onClick={() => set("end", null)}
              data-slot="life-event-remove-end"
            >
              <X className="size-4" aria-hidden="true" />
              {t("lifeEvents.fields.removeEnd")}
            </Button>
          </div>
          <PrecisionDate
            id={ids.end}
            value={draft.end}
            precision={draft.precision}
            onChange={(v) => set("end", v)}
            invalid={!!errors.end}
            describedBy={errors.end ? `${ids.end}-error` : undefined}
            today={today}
          />
          <FieldError id={`${ids.end}-error`} message={fieldError("end")} />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor={ids.note} noColon className="gap-1">
          {t("lifeEvents.fields.note")}{" "}
          <span className="text-muted-foreground font-normal">
            {t("lifeEvents.fields.optionalTag")}
          </span>
        </Label>
        <Textarea
          id={ids.note}
          rows={3}
          value={draft.note}
          placeholder={t("lifeEvents.fields.notePlaceholder")}
          onChange={(e) => set("note", e.target.value)}
          aria-invalid={!!errors.note || undefined}
          aria-describedby={errors.note ? `${ids.note}-error` : undefined}
          data-slot="life-event-note"
        />
        <FieldError id={`${ids.note}-error`} message={fieldError("note")} />
      </div>

      <p
        className="text-muted-foreground flex items-start gap-2 text-xs"
        data-slot="life-event-privacy"
      >
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{t("lifeEvents.privacy")}</span>
      </p>

      {saveError && (
        <div
          role="alert"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {saveError}
        </div>
      )}

      {footerSlot ? createPortal(footer, footerSlot) : footer}
    </form>
  );
}
