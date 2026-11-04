"use client";

/**
 * v1.43 (#614) — Settings → Anamnese → "Life circumstances".
 *
 * Six collapsible sections over `GET /api/anamnesis/life-circumstances`. Each
 * section saves on its own (a section is one decision about one part of a
 * life, so its Save sits at the end of its own body rather than at the end of
 * the card), every question offers "no answer", follow-up questions only
 * appear where they apply, and each section carries its "valid since", its
 * AI switch and the quiet yearly "still true?" line.
 *
 * Everything shown as a number (pack-years, minutes per week, the AUDIT-C
 * verdict) comes resolved from the server; this file renders it and never
 * recomputes it.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";

import { AuditCPanel } from "@/components/records/audit-c-panel";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { Switch } from "@/components/ui/switch";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { LifeCircumstancesDto } from "@/lib/profile/life-circumstances";
import { queryKeys } from "@/lib/query-keys";
import {
  SHIFT_SCHEDULE_VALUES,
  SMOKING_STATUS_VALUES,
} from "@/lib/validations/health-profile-facts";
import {
  DIET_PATTERNS,
  DIET_SPECIFICS,
  HEALTH_GOALS,
  LATEST_CAFFEINE,
  TOBACCO_PRODUCTS,
  WORK_EXPOSURES,
  WORK_PHYSICAL_NATURE,
  WORK_SITUATIONS,
  type ActivityHabitValue,
  type FreeWeekdaysValue,
  type HabitsValue,
  type HealthGoalsValue,
  type LifeAiSection,
  type TobaccoDetailValue,
  type WorkContextValue,
} from "@/lib/validations/life-circumstances";

type Section = LifeCircumstancesDto["sections"][number];
type Fact = Section["facts"][number];
type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const EMPTY = {
  TOBACCO_DETAIL: {
    schema: 1,
    products: [],
    cigarettesPerDay: null,
    startYear: null,
    quitMonth: null,
    secondhandSmoke: null,
  } as TobaccoDetailValue,
  ACTIVITY_HABIT: {
    schema: 1,
    moderateDaysPerWeek: null,
    moderateMinutesPerDay: null,
    sittingHoursWorkday: null,
  } as ActivityHabitValue,
  WORK_CONTEXT: {
    schema: 1,
    situation: null,
    physicalNature: null,
    nightWork: null,
    exposures: [],
  } as WorkContextValue,
  FREE_WEEKDAYS: { schema: 1, days: [] } as FreeWeekdaysValue,
  HABITS: {
    schema: 1,
    napRegularly: null,
    snoringReported: null,
    dietPattern: null,
    dietSpecifics: [],
    lateMealsPerWeek: null,
    fruitVegPortionsPerDay: null,
    caffeineDrinksPerDay: null,
    latestCaffeine: null,
  } as HabitsValue,
  HEALTH_GOALS: { schema: 1, goals: [] } as HealthGoalsValue,
};
type LifeKind = keyof typeof EMPTY;
type Values = {
  SMOKING_STATUS: string;
  SHIFT_SCHEDULE: string;
} & { [K in LifeKind]: (typeof EMPTY)[K] };

/** An object value with nothing answered is "no answer" and stores nothing. */
function isEmptyValue(value: Record<string, unknown>): boolean {
  return Object.entries(value).every(
    ([key, v]) =>
      key === "schema" || v === null || (Array.isArray(v) && v.length === 0),
  );
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function initialValues(facts: readonly Fact[]): Values {
  const by = (kind: string) =>
    facts.find((fact) => fact.kind === kind && !fact.unreadable)?.value;
  return {
    SMOKING_STATUS: (by("SMOKING_STATUS") as string | undefined) ?? "",
    SHIFT_SCHEDULE: (by("SHIFT_SCHEDULE") as string | undefined) ?? "",
    TOBACCO_DETAIL:
      (by("TOBACCO_DETAIL") as TobaccoDetailValue | undefined) ??
      EMPTY.TOBACCO_DETAIL,
    ACTIVITY_HABIT:
      (by("ACTIVITY_HABIT") as ActivityHabitValue | undefined) ??
      EMPTY.ACTIVITY_HABIT,
    WORK_CONTEXT:
      (by("WORK_CONTEXT") as WorkContextValue | undefined) ??
      EMPTY.WORK_CONTEXT,
    FREE_WEEKDAYS:
      (by("FREE_WEEKDAYS") as FreeWeekdaysValue | undefined) ??
      EMPTY.FREE_WEEKDAYS,
    HABITS: (by("HABITS") as HabitsValue | undefined) ?? EMPTY.HABITS,
    HEALTH_GOALS:
      (by("HEALTH_GOALS") as HealthGoalsValue | undefined) ??
      EMPTY.HEALTH_GOALS,
  };
}

/**
 * Write one kind: POST a first answer, PATCH (a dated successor) a changed
 * one, DELETE an answer cleared to "no answer". Unchanged kinds send nothing.
 */
async function writeKind(
  kind: string,
  next: string | Record<string, unknown>,
  current: Fact | undefined,
  validFrom: string | undefined,
): Promise<void> {
  const empty = typeof next === "string" ? next === "" : isEmptyValue(next);
  if (current && JSON.stringify(current.value) === JSON.stringify(next)) return;
  if (empty) {
    if (current) await apiDelete(`/api/anamnesis/facts/${current.id}`);
    return;
  }
  if (current) {
    await apiPatch(`/api/anamnesis/facts/${current.id}`, {
      value: next,
      ...(validFrom ? { validFrom } : {}),
    });
  } else {
    await apiPost("/api/anamnesis/facts", {
      kind,
      value: next,
      ...(validFrom ? { validFrom } : {}),
    });
  }
}

// ── Small field primitives ───────────────────────────────────────────────────

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {/* Block, so the colon follows a label that wraps instead of standing
          alone at the far edge as a flex item. */}
      <Label htmlFor={id} className="block leading-snug">
        {label}
      </Label>
      {children}
    </div>
  );
}

function ChoiceField({
  id,
  label,
  value,
  options,
  onChange,
  t,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  t: Translate;
  disabled: boolean;
}) {
  return (
    <Field id={id} label={label}>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("records.life.noAnswer")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function BoolField({
  id,
  label,
  value,
  onChange,
  t,
  disabled,
}: {
  id: string;
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  t: Translate;
  disabled: boolean;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      value={value === null ? "" : value ? "yes" : "no"}
      options={[
        { value: "yes", label: t("records.life.yes") },
        { value: "no", label: t("records.life.no") },
      ]}
      onChange={(next) => onChange(next === "" ? null : next === "yes")}
      t={t}
      disabled={disabled}
    />
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number | null) => void;
  disabled: boolean;
}) {
  // What the person is typing. A year passes through "1", "19" and "198" on
  // its way to "1985", so clamping each keystroke turned the first digit into
  // the minimum and the field could not be typed into. A value is committed
  // once it is in range, and leaving the field puts the committed one back.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        inputMode={step < 1 ? "decimal" : "numeric"}
        min={min}
        max={max}
        step={step}
        value={draft ?? (value === null ? "" : String(value))}
        disabled={disabled}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw === "") return onChange(null);
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            onChange(parsed);
          }
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

/**
 * A month typed as YYYY-MM. Only a complete month is committed, so the field
 * keeps what is being typed on its own: holding it to the committed value
 * threw away every keystroke until the text was a whole month, and only a
 * paste got through. Leaving the field pads "2019-3" to "2019-03" and puts
 * the committed month back over anything that is not one.
 */
function QuitMonthInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      id={id}
      placeholder="YYYY-MM"
      inputMode="numeric"
      maxLength={7}
      value={draft ?? value ?? ""}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const month = completeMonth(raw);
        if (month !== undefined) onChange(month);
      }}
      onBlur={() => {
        if (draft !== null) {
          const short = /^(\d{4})-([1-9])$/.exec(draft.trim());
          if (short) onChange(`${short[1]}-0${short[2]}`);
        }
        setDraft(null);
      }}
    />
  );
}

/** A whole month, null for an emptied field, undefined while still typing. */
function completeMonth(raw: string): string | null | undefined {
  const text = raw.trim();
  if (text === "") return null;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : undefined;
}

function MultiField<T extends string>({
  id,
  label,
  hint,
  options,
  value,
  onChange,
  max,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: readonly T[];
  onChange: (value: T[]) => void;
  max?: number;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-2" data-slot={id}>
      <legend className="text-sm font-medium">{label}</legend>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {options.map((option) => {
          const checked = value.includes(option.value);
          const full = max !== undefined && value.length >= max && !checked;
          return (
            <label
              key={option.value}
              className="flex min-h-11 min-w-0 items-center gap-2 text-sm sm:min-h-9"
            >
              <Checkbox
                className="shrink-0"
                checked={checked}
                disabled={disabled || full}
                onCheckedChange={(next) =>
                  onChange(
                    next === true
                      ? [...value, option.value]
                      : value.filter((item) => item !== option.value),
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Month and year of "valid since", as `YYYY-MM`. */
function MonthField({
  id,
  value,
  onChange,
  t,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  t: Translate;
  disabled: boolean;
}) {
  const fmt = useFormatters();
  const [year, month] = value.split("-");
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 80 }, (_, i) => String(thisYear - i));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">
        {t("records.life.validSince")}
      </legend>
      <div className="grid grid-cols-2 gap-4">
        <NativeSelect
          id={`${id}-month`}
          aria-label={t("records.life.month")}
          value={month}
          disabled={disabled}
          onChange={(event) => onChange(`${year}-${event.target.value}`)}
        >
          {Array.from({ length: 12 }, (_, i) => {
            const m = String(i + 1).padStart(2, "0");
            return (
              <option key={m} value={m}>
                {fmt.monthShort(new Date(Date.UTC(2026, i, 15)))}
              </option>
            );
          })}
        </NativeSelect>
        <NativeSelect
          id={`${id}-year`}
          aria-label={t("records.life.year")}
          value={year}
          disabled={disabled}
          onChange={(event) => onChange(`${event.target.value}-${month}`)}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </NativeSelect>
      </div>
    </fieldset>
  );
}

/** The kinds a section writes, in the order it writes them. */
const SECTION_KINDS: Record<Section["key"], ReadonlyArray<keyof Values>> = {
  tobacco: ["SMOKING_STATUS", "TOBACCO_DETAIL"],
  alcohol: [],
  activity: ["ACTIVITY_HABIT"],
  work: ["SHIFT_SCHEDULE", "WORK_CONTEXT", "FREE_WEEKDAYS"],
  habits: ["HABITS"],
  goals: ["HEALTH_GOALS"],
};

// ── One section ──────────────────────────────────────────────────────────────

function SectionBody({
  section,
  data,
  t,
  onSaved,
}: {
  section: Section;
  data: LifeCircumstancesDto;
  t: Translate;
  onSaved: () => void;
}) {
  const fmt = useFormatters();
  const [values, setValues] = useState<Values>(() =>
    initialValues(section.facts),
  );
  const [since, setSince] = useState(currentMonth);
  const set = <K extends keyof Values>(kind: K, value: Values[K]) =>
    setValues((old) => ({ ...old, [kind]: value }));
  const patch = <K extends LifeKind>(
    kind: K,
    change: Partial<(typeof EMPTY)[K]>,
  ) => setValues((old) => ({ ...old, [kind]: { ...old[kind], ...change } }));

  const save = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: async () => {
      const validFrom = since === currentMonth() ? undefined : `${since}-01`;
      for (const kind of SECTION_KINDS[section.key]) {
        await writeKind(
          kind,
          values[kind] as string | Record<string, unknown>,
          section.facts.find((fact) => fact.kind === kind),
          validFrom,
        );
      }
    },
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.savedToast"));
      onSaved();
    },
    onError: (error) => {
      onSaved();
      showErrorToast(t("records.life.saveError"), { cause: error });
    },
  });
  const disabled = save.isPending;
  const id = (name: string) => `life-${section.key}-${name}`;
  const opts = <V extends string>(list: readonly V[], ns: string) =>
    list.map((value) => ({ value, label: t(`${ns}.${value}`) }));

  let fields: ReactNode = null;
  switch (section.key) {
    case "tobacco": {
      const v = values.TOBACCO_DETAIL;
      fields = (
        <>
          <ChoiceField
            id={id("status")}
            label={t("records.life.fields.smokingStatus")}
            value={values.SMOKING_STATUS}
            options={opts(
              SMOKING_STATUS_VALUES,
              "records.profileFacts.values.SMOKING_STATUS",
            )}
            onChange={(next) => set("SMOKING_STATUS", next)}
            t={t}
            disabled={disabled}
          />
          {values.SMOKING_STATUS !== "NEVER" ? (
            <>
              <MultiField
                id={id("products")}
                label={t("records.life.fields.products")}
                options={opts(TOBACCO_PRODUCTS, "records.life.values.products")}
                value={v.products}
                onChange={(products) =>
                  patch("TOBACCO_DETAIL", {
                    products,
                    ...(products.includes("cigarettes")
                      ? {}
                      : { cigarettesPerDay: null }),
                  })
                }
                disabled={disabled}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                {v.products.includes("cigarettes") ? (
                  <NumberField
                    id={id("cigarettes")}
                    label={t("records.life.fields.cigarettesPerDay")}
                    value={v.cigarettesPerDay}
                    min={1}
                    max={100}
                    onChange={(cigarettesPerDay) =>
                      patch("TOBACCO_DETAIL", { cigarettesPerDay })
                    }
                    disabled={disabled}
                  />
                ) : null}
                <NumberField
                  id={id("start")}
                  label={t("records.life.fields.startYear")}
                  value={v.startYear}
                  min={1900}
                  max={new Date().getFullYear()}
                  onChange={(startYear) =>
                    patch("TOBACCO_DETAIL", { startYear })
                  }
                  disabled={disabled}
                />
              </div>
              {values.SMOKING_STATUS === "FORMER" ? (
                <Field
                  id={id("quit")}
                  label={t("records.life.fields.quitMonth")}
                >
                  <QuitMonthInput
                    id={id("quit")}
                    value={v.quitMonth}
                    disabled={disabled}
                    onChange={(quitMonth) =>
                      patch("TOBACCO_DETAIL", { quitMonth })
                    }
                  />
                </Field>
              ) : null}
            </>
          ) : null}
          <BoolField
            id={id("secondhand")}
            label={t("records.life.fields.secondhandSmoke")}
            value={v.secondhandSmoke}
            onChange={(secondhandSmoke) =>
              patch("TOBACCO_DETAIL", { secondhandSmoke })
            }
            t={t}
            disabled={disabled}
          />
          {data.derived.packYears.status === "computed" &&
          data.derived.packYears.value !== null ? (
            <p className="text-sm" data-slot="life-pack-years">
              {t("records.life.derived.packYears", {
                value: fmt.number(data.derived.packYears.value, 1),
              })}
            </p>
          ) : data.derived.packYears.status === "missing_inputs" &&
            values.SMOKING_STATUS !== "" &&
            values.SMOKING_STATUS !== "NEVER" ? (
            <p className="text-muted-foreground text-xs">
              {t("records.life.derived.packYearsMissing")}
            </p>
          ) : null}
        </>
      );
      break;
    }
    case "activity": {
      const v = values.ACTIVITY_HABIT;
      const minutes = data.derived.activityMinutesPerWeek;
      fields = (
        <>
          <ChoiceField
            id={id("days")}
            label={t("records.life.fields.moderateDaysPerWeek")}
            value={
              v.moderateDaysPerWeek === null
                ? ""
                : String(v.moderateDaysPerWeek)
            }
            options={Array.from({ length: 8 }, (_, d) => ({
              value: String(d),
              label: String(d),
            }))}
            onChange={(next) =>
              patch("ACTIVITY_HABIT", {
                moderateDaysPerWeek: next === "" ? null : Number(next),
              })
            }
            t={t}
            disabled={disabled}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id={id("minutes")}
              label={t("records.life.fields.moderateMinutesPerDay")}
              value={v.moderateMinutesPerDay}
              min={0}
              max={600}
              onChange={(moderateMinutesPerDay) =>
                patch("ACTIVITY_HABIT", { moderateMinutesPerDay })
              }
              disabled={disabled}
            />
            <NumberField
              id={id("sitting")}
              label={t("records.life.fields.sittingHoursWorkday")}
              value={v.sittingHoursWorkday}
              min={0}
              max={24}
              step={0.5}
              onChange={(hours) =>
                patch("ACTIVITY_HABIT", {
                  sittingHoursWorkday:
                    hours === null ? null : Math.round(hours * 2) / 2,
                })
              }
              disabled={disabled}
            />
          </div>
          {minutes.value !== null ? (
            <p className="text-sm" data-slot="life-activity-minutes">
              {t("records.life.derived.activityMinutes", {
                value: fmt.integer(minutes.value),
              })}{" "}
              {minutes.meetsWho150
                ? t("records.life.derived.meetsWho")
                : t("records.life.derived.belowWho")}
            </p>
          ) : null}
          {minutes.measuredStepsAvailable ? (
            <p className="text-muted-foreground text-xs">
              {t("records.life.derived.measuredSteps")}
            </p>
          ) : null}
        </>
      );
      break;
    }
    case "work": {
      const v = values.WORK_CONTEXT;
      const shiftWork =
        values.SHIFT_SCHEDULE === "FIXED_SHIFT" ||
        values.SHIFT_SCHEDULE === "ROTATING";
      fields = (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <ChoiceField
              id={id("situation")}
              label={t("records.life.fields.situation")}
              value={v.situation ?? ""}
              options={opts(WORK_SITUATIONS, "records.life.values.situation")}
              onChange={(next) =>
                patch("WORK_CONTEXT", {
                  situation:
                    next === ""
                      ? null
                      : (next as WorkContextValue["situation"]),
                })
              }
              t={t}
              disabled={disabled}
            />
            <ChoiceField
              id={id("nature")}
              label={t("records.life.fields.physicalNature")}
              value={v.physicalNature ?? ""}
              options={opts(
                WORK_PHYSICAL_NATURE,
                "records.life.values.physicalNature",
              )}
              onChange={(next) =>
                patch("WORK_CONTEXT", {
                  physicalNature:
                    next === ""
                      ? null
                      : (next as WorkContextValue["physicalNature"]),
                })
              }
              t={t}
              disabled={disabled}
            />
            <ChoiceField
              id={id("shift")}
              label={t("records.life.fields.shiftSchedule")}
              value={values.SHIFT_SCHEDULE}
              options={opts(
                SHIFT_SCHEDULE_VALUES,
                "records.profileFacts.values.SHIFT_SCHEDULE",
              )}
              onChange={(next) => set("SHIFT_SCHEDULE", next)}
              t={t}
              disabled={disabled}
            />
            {shiftWork ? (
              <BoolField
                id={id("night")}
                label={t("records.life.fields.nightWork")}
                value={v.nightWork}
                onChange={(nightWork) => patch("WORK_CONTEXT", { nightWork })}
                t={t}
                disabled={disabled}
              />
            ) : null}
          </div>
          <MultiField
            id={id("exposures")}
            label={t("records.life.fields.exposures")}
            options={opts(WORK_EXPOSURES, "records.life.values.exposures")}
            value={v.exposures}
            onChange={(exposures) => patch("WORK_CONTEXT", { exposures })}
            disabled={disabled}
          />
          <MultiField
            id={id("free")}
            label={t("records.life.fields.freeWeekdays")}
            hint={
              values.FREE_WEEKDAYS.days.length === 0
                ? t("records.life.derived.freeDaysDefault")
                : undefined
            }
            options={(["1", "2", "3", "4", "5", "6", "7"] as const).map(
              (day) => ({
                value: day,
                label: t(`records.life.values.weekdays.${day}`),
              }),
            )}
            value={
              values.FREE_WEEKDAYS.days.map(String) as Array<
                "1" | "2" | "3" | "4" | "5" | "6" | "7"
              >
            }
            onChange={(days) =>
              set("FREE_WEEKDAYS", {
                schema: 1,
                days: days.map(Number).sort((a, b) => a - b),
              })
            }
            disabled={disabled}
          />
        </>
      );
      break;
    }
    case "habits": {
      const v = values.HABITS;
      const num = (
        key:
          | "lateMealsPerWeek"
          | "fruitVegPortionsPerDay"
          | "caffeineDrinksPerDay",
        max: number,
      ) => (
        <NumberField
          id={id(key)}
          label={t(`records.life.fields.${key}`)}
          value={v[key]}
          min={0}
          max={max}
          onChange={(next) => patch("HABITS", { [key]: next })}
          disabled={disabled}
        />
      );
      fields = (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <BoolField
              id={id("nap")}
              label={t("records.life.fields.napRegularly")}
              value={v.napRegularly}
              onChange={(napRegularly) => patch("HABITS", { napRegularly })}
              t={t}
              disabled={disabled}
            />
            <BoolField
              id={id("snoring")}
              label={t("records.life.fields.snoringReported")}
              value={v.snoringReported}
              onChange={(snoringReported) =>
                patch("HABITS", { snoringReported })
              }
              t={t}
              disabled={disabled}
            />
            <ChoiceField
              id={id("diet")}
              label={t("records.life.fields.dietPattern")}
              value={v.dietPattern ?? ""}
              options={opts(DIET_PATTERNS, "records.life.values.dietPattern")}
              onChange={(next) =>
                patch("HABITS", {
                  dietPattern:
                    next === "" ? null : (next as HabitsValue["dietPattern"]),
                })
              }
              t={t}
              disabled={disabled}
            />
            <ChoiceField
              id={id("latest")}
              label={t("records.life.fields.latestCaffeine")}
              value={v.latestCaffeine ?? ""}
              options={opts(
                LATEST_CAFFEINE,
                "records.life.values.latestCaffeine",
              )}
              onChange={(next) =>
                patch("HABITS", {
                  latestCaffeine:
                    next === ""
                      ? null
                      : (next as HabitsValue["latestCaffeine"]),
                })
              }
              t={t}
              disabled={disabled}
            />
            {num("lateMealsPerWeek", 7)}
            {num("fruitVegPortionsPerDay", 15)}
            {num("caffeineDrinksPerDay", 20)}
          </div>
          <MultiField
            id={id("specifics")}
            label={t("records.life.fields.dietSpecifics")}
            options={opts(DIET_SPECIFICS, "records.life.values.dietSpecifics")}
            value={v.dietSpecifics}
            onChange={(dietSpecifics) => patch("HABITS", { dietSpecifics })}
            disabled={disabled}
          />
        </>
      );
      break;
    }
    case "goals": {
      fields = (
        <MultiField
          id={id("goals")}
          label={t("records.life.fields.goals")}
          hint={t("records.life.fields.goalsHint")}
          options={opts(HEALTH_GOALS, "records.life.values.goals")}
          value={values.HEALTH_GOALS.goals}
          max={3}
          onChange={(goals) => set("HEALTH_GOALS", { schema: 1, goals })}
          disabled={disabled}
        />
      );
      break;
    }
    case "alcohol":
      return <AuditCPanel data={data.auditC} onChanged={onSaved} />;
  }

  return (
    <div className="space-y-4">
      {fields}
      <MonthField
        id={id("since")}
        value={since}
        onChange={setSince}
        t={t}
        disabled={disabled}
      />
      <SettingsCardActions>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={disabled}
          onClick={() => save.mutate()}
          data-slot={`life-save-${section.key}`}
        >
          {save.isPending && (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          {t("records.life.save")}
        </Button>
      </SettingsCardActions>
    </div>
  );
}

// ── The card body ────────────────────────────────────────────────────────────

export function LifeCircumstancesManager() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.lifeCircumstances(),
    queryFn: () =>
      apiGet<LifeCircumstancesDto>("/api/anamnesis/life-circumstances"),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.lifeCircumstances(),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.insightsAdvisor(),
    });
  };

  const aiSwitch = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: (change: { section: LifeAiSection; on: boolean }) =>
      apiPatch("/api/anamnesis/life-circumstances/ai-sections", {
        sections: { [change.section]: change.on },
      }),
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.ai.savedToast"));
      refresh();
    },
    onError: (error) =>
      showErrorToast(t("records.life.ai.saveError"), { cause: error }),
  });

  const confirm = useMutation({
    mutationKey: queryKeys.lifeCircumstances(),
    mutationFn: (section: Section["key"]) =>
      apiPost("/api/anamnesis/life-circumstances/confirm", { section }),
    onSuccess: () => {
      toastWrittenOutcome("success", t("records.life.review.confirmedToast"));
      refresh();
    },
    onError: (error) =>
      showErrorToast(t("records.life.review.confirmError"), { cause: error }),
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        error={query.error}
        title={t("records.life.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const data = query.data;
  if (!data) {
    return (
      <Loader2
        className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
        aria-hidden
      />
    );
  }

  return (
    <div
      className="divide-border divide-y"
      data-slot="life-circumstances-manager"
    >
      {data.sections.map((raw) => {
        const switchId = `life-ai-${raw.key}`;
        return (
          <details
            key={raw.key}
            className="group py-3"
            data-slot={`life-section-${raw.key}`}
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {t(`records.life.sections.${raw.key}.title`)}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {raw.lastConfirmedAt
                    ? t("records.life.lastConfirmed", {
                        date: fmt.date(new Date(raw.lastConfirmedAt)),
                      })
                    : t("records.life.notAnswered")}
                </span>
              </span>
              <ChevronDown
                className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="space-y-4 pt-3">
              {raw.reviewDue ? (
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm">
                    {t("records.life.review.question")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0 sm:min-h-9"
                    disabled={confirm.isPending}
                    onClick={() => confirm.mutate(raw.key)}
                  >
                    {t("records.life.review.confirm")}
                  </Button>
                </div>
              ) : null}
              {raw.facts.some((fact) => fact.unreadable) ? (
                <p className="text-destructive text-xs">
                  {t("records.life.unreadable")}
                </p>
              ) : null}
              <div className="flex min-h-11 items-center justify-between gap-4">
                <label htmlFor={switchId} className="text-sm">
                  {t("records.life.ai.label")}
                </label>
                <Switch
                  id={switchId}
                  checked={raw.aiIncluded}
                  disabled={aiSwitch.isPending}
                  onCheckedChange={(on) =>
                    aiSwitch.mutate({ section: raw.aiSection, on })
                  }
                />
              </div>
              {raw.key === "work" ? (
                <div className="flex min-h-11 items-center justify-between gap-4">
                  <label htmlFor="life-ai-shift" className="text-sm">
                    {t("records.life.ai.shiftLabel")}
                  </label>
                  <Switch
                    id="life-ai-shift"
                    checked={data.extraAiSections.SHIFT_SCHEDULE}
                    disabled={aiSwitch.isPending}
                    onCheckedChange={(on) =>
                      aiSwitch.mutate({ section: "SHIFT_SCHEDULE", on })
                    }
                  />
                </div>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {t("records.life.ai.hint")}
              </p>
              <SectionBody
                // A refetch with new answers remounts the form on them.
                key={JSON.stringify(raw.facts.map((fact) => fact.id))}
                section={raw}
                data={data}
                t={t}
                onSaved={refresh}
              />
            </div>
          </details>
        );
      })}
    </div>
  );
}
