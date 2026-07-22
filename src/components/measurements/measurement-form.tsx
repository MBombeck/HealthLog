"use client";

import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, MoreHorizontal, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { MEASUREMENT_NOTES_MAX_LENGTH } from "@/lib/validations/measurement";
import {
  getLastUsedMeasurementType,
  setLastUsedMeasurementType,
} from "@/lib/measurements/last-used-type";

const MAX_COMMENT_LENGTH = MEASUREMENT_NOTES_MAX_LENGTH;

const MEASUREMENT_TYPES = [
  {
    value: "BLOOD_PRESSURE",
    labelKey: "measurements.typeBloodPressure",
    unit: "mmHg",
  },
  {
    value: "WEIGHT",
    labelKey: "measurements.typeWeight",
    unit: "kg",
    placeholder: "75.5",
  },
  {
    value: "PULSE",
    labelKey: "measurements.typePulse",
    unit: "bpm",
    placeholder: "72",
  },
  {
    value: "BODY_FAT",
    labelKey: "measurements.typeBodyFat",
    unit: "%",
    placeholder: "22",
  },
  {
    value: "SLEEP_DURATION",
    labelKey: "measurements.typeSleep",
    unitKey: "measurements.unitHours",
    placeholder: "7.5",
  },
  {
    value: "ACTIVITY_STEPS",
    labelKey: "measurements.typeSteps",
    unitKey: "measurements.unitSteps",
    placeholder: "8000",
  },
  {
    value: "BLOOD_GLUCOSE",
    labelKey: "measurements.typeBloodGlucose",
    unit: "mg/dL",
    placeholder: "95",
  },
  {
    value: "TOTAL_BODY_WATER",
    labelKey: "measurements.typeTotalBodyWater",
    unit: "kg",
    placeholder: "42",
  },
  {
    value: "BONE_MASS",
    labelKey: "measurements.typeBoneMass",
    unit: "kg",
    placeholder: "3.2",
  },
  {
    value: "OXYGEN_SATURATION",
    labelKey: "measurements.typeOxygenSaturation",
    unit: "%",
    placeholder: "98",
  },
  {
    value: "BODY_TEMPERATURE",
    labelKey: "measurements.typeBodyTemperature",
    unit: "°C",
    placeholder: "36.6",
  },
  // v1.25 — physical / clinical signals. Manual web capture so a web-only
  // self-hoster can log them (the iOS client + measurements API already do).
  {
    value: "WAIST_CIRCUMFERENCE",
    labelKey: "measurements.typeWaistCircumference",
    unit: "cm",
    placeholder: "84",
  },
  {
    value: "WAIST_TO_HEIGHT",
    labelKey: "measurements.typeWaistToHeight",
    unitKey: "measurements.unitRatio",
    placeholder: "0.48",
  },
  {
    value: "GRIP_STRENGTH",
    labelKey: "measurements.typeGripStrength",
    unit: "kg",
    placeholder: "38",
  },
  {
    value: "PAIN_NRS",
    labelKey: "measurements.typePainNrs",
    unitKey: "measurements.unitScore",
    placeholder: "0",
  },
] as const;

// v1.4.34 IW-G — single source of truth for the `/measurements?add=<TYPE>`
// deep link the Insights empty-state CTAs ship. Derived from the form's
// MEASUREMENT_TYPES so a new row in the form is immediately usable as
// a deep-link target.
export const MEASUREMENT_FORM_TYPE_VALUES = MEASUREMENT_TYPES.map(
  (t) => t.value,
) as readonly string[];

// Legacy / Insights-internal tokens that predate the canonical enum.
// Older empty-state CTAs and a handful of dashboard tiles still emit
// these — translate them to the form's canonical value so the link
// keeps working without forcing every caller to rename in lockstep.
export const ADD_TOKEN_ALIASES: Readonly<Record<string, string>> = {
  GLUCOSE: "BLOOD_GLUCOSE",
  TEMPERATURE: "BODY_TEMPERATURE",
  HEART_RATE: "PULSE",
  BMI: "WEIGHT",
};

/**
 * Resolve a `?add=<token>` deep-link value to a real form type, or
 * `null` when the token has no canonical mapping. Centralised so the
 * page-level dispatcher and the F-1 contract test consume the same
 * resolver.
 */
export function resolveAddToken(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const aliased = ADD_TOKEN_ALIASES[token] ?? token;
  return MEASUREMENT_FORM_TYPE_VALUES.includes(aliased) ? aliased : null;
}

const GLUCOSE_CONTEXTS = [
  { value: "FASTING", labelKey: "measurements.glucoseContextFasting" },
  {
    value: "POSTPRANDIAL",
    labelKey: "measurements.glucoseContextPostprandial",
  },
  { value: "RANDOM", labelKey: "measurements.glucoseContextRandom" },
  { value: "BEDTIME", labelKey: "measurements.glucoseContextBedtime" },
] as const;

type GlucoseContextValue = (typeof GLUCOSE_CONTEXTS)[number]["value"];

interface MeasurementFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  defaultType?: string;
  /**
   * v1.4.27 R4 RC2 — when the form is mounted inside a
   * `<ResponsiveSheet>` the caller passes the sheet's footer slot
   * element here. The form's action-row (kebab + Cancel + Save) is
   * portalled into that slot so the bottom-sheet branch can
   * sticky-pin it; the Save button stays associated with the logical
   * `<form>` via the HTML `form` attribute.
   */
  footerSlot?: HTMLElement | null;
}

function getDefaultMeasuredAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/**
 * Field label that keeps the "Name (unit)" translation on a single line even
 * in the narrow three-column blood-pressure grid: the metric name truncates if
 * it must, while the unit renders as a small muted affix that never wraps. The
 * label strings stay localised — we split the trailing "(unit)" the catalogue
 * already carries rather than dropping it (so "mmHg" / "bpm" / locale variants
 * like "lpm" survive).
 */
function UnitLabel({ htmlFor, label }: { htmlFor: string; label: string }) {
  const match = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(label);
  const name = match ? match[1] : label;
  const unit = match ? match[2] : null;
  return (
    <Label htmlFor={htmlFor} className="flex items-baseline gap-1">
      <span className="truncate">{name}</span>
      {unit ? (
        <span className="text-muted-foreground shrink-0 text-xs font-normal">
          {unit}
        </span>
      ) : null}
    </Label>
  );
}

export function MeasurementForm({
  onSuccess,
  onCancel,
  defaultType,
  footerSlot,
}: MeasurementFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Normalize legacy BP types to combined mode
  const normalizedDefault =
    defaultType === "BLOOD_PRESSURE_SYS" || defaultType === "BLOOD_PRESSURE_DIA"
      ? "BLOOD_PRESSURE"
      : defaultType;

  // v1.30.1 M3 — an explicit deep-link default always wins; absent one,
  // seed from the last type the user actually saved rather than always
  // landing on BLOOD_PRESSURE. Lazy initializer so the localStorage read
  // happens once, at mount, not on every render.
  const [type, setType] = useState(
    () =>
      normalizedDefault ||
      getLastUsedMeasurementType(MEASUREMENT_FORM_TYPE_VALUES) ||
      "BLOOD_PRESSURE",
  );
  const [value, setValue] = useState("");
  const [sysBp, setSysBp] = useState("");
  const [diaBp, setDiaBp] = useState("");
  const [pulse, setPulse] = useState("");
  const [notes, setNotes] = useState("");
  const [measuredAt, setMeasuredAt] = useState(getDefaultMeasuredAtValue);
  const [glucoseContext, setGlucoseContext] =
    useState<GlucoseContextValue>("FASTING");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v1.4.27 MB3 — wire `aria-describedby` on every required field so
  // screen readers announce the form-level error banner the moment it
  // surfaces. The banner already carries `role="alert"`, so the
  // descriptor relationship is purely additive.
  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;

  // v1.4.27 R4 RC2 — stable id so the portalled Save button can keep
  // its `<form>` association via the HTML `form` attribute.
  const formId = useId();

  const typeInfo = MEASUREMENT_TYPES.find((t) => t.value === type);
  const isBpMode = type === "BLOOD_PRESSURE";
  const isGlucoseMode = type === "BLOOD_GLUCOSE";

  function resetForm() {
    setType(normalizedDefault || "BLOOD_PRESSURE");
    setValue("");
    setSysBp("");
    setDiaBp("");
    setPulse("");
    setNotes("");
    setMeasuredAt(getDefaultMeasuredAtValue());
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const timestamp = new Date(measuredAt).toISOString();

      if (isBpMode) {
        // Batch: Sys + Dia + optional Pulse
        const batch: Array<{
          type: string;
          value: number;
          measuredAt: string;
          notes?: string;
        }> = [
          {
            type: "BLOOD_PRESSURE_SYS",
            value: parseFloat(sysBp),
            measuredAt: timestamp,
            notes: notes || undefined,
          },
          {
            type: "BLOOD_PRESSURE_DIA",
            value: parseFloat(diaBp),
            measuredAt: timestamp,
            notes: notes || undefined,
          },
        ];

        if (pulse) {
          batch.push({
            type: "PULSE",
            value: parseFloat(pulse),
            measuredAt: timestamp,
            notes: notes || undefined,
          });
        }

        await apiPost("/api/measurements", batch);
      } else {
        // Single measurement
        await apiPost("/api/measurements", {
          type,
          value: parseFloat(value),
          measuredAt: timestamp,
          notes: notes || undefined,
          ...(isGlucoseMode ? { glucoseContext } : {}),
        });
      }

      // v1.30.1 M3 — remember this type as the next mount's smart
      // default (deep links still override it).
      setLastUsedMeasurementType(type);

      // Reset form
      setValue("");
      setSysBp("");
      setDiaBp("");
      setPulse("");
      setNotes("");
      await invalidateKeys(queryClient, measurementDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch (err) {
      setError(localizedApiError(err, t, "measurements.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const footerNode = (
    <div className="flex w-full items-center justify-between gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            disabled={loading}
            aria-label={t("common.moreOptions")}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={resetForm}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {t("measurements.formReset")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" form={formId} disabled={loading}>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {t("common.save")}
        </Button>
      </div>
    </div>
  );

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-4">
      <FieldGroup htmlFor="measurement-type" label={t("measurements.type")}>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="measurement-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEASUREMENT_TYPES.map((mt) => (
              <SelectItem key={mt.value} value={mt.value}>
                {t(mt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldGroup>

      {isBpMode ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <UnitLabel htmlFor="sys" label={t("measurements.systolicLabel")} />
            <Input
              id="sys"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              step="1"
              value={sysBp}
              onChange={(e) => setSysBp(e.target.value)}
              placeholder="120"
              required
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
              min={60}
              max={280}
            />
          </div>
          <div className="space-y-2">
            <UnitLabel htmlFor="dia" label={t("measurements.diastolicLabel")} />
            <Input
              id="dia"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              step="1"
              value={diaBp}
              onChange={(e) => setDiaBp(e.target.value)}
              placeholder="80"
              required
              aria-required="true"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
              min={30}
              max={200}
            />
          </div>
          <div className="space-y-2">
            <UnitLabel htmlFor="puls" label={t("measurements.pulseLabel")} />
            <Input
              id="puls"
              type="number"
              inputMode="numeric"
              enterKeyHint="next"
              step="1"
              value={pulse}
              onChange={(e) => setPulse(e.target.value)}
              placeholder="72"
              aria-invalid={!!error || undefined}
              aria-describedby={errorDescriptor}
              min={30}
              max={220}
            />
          </div>
        </div>
      ) : (
        <FieldGroup
          htmlFor="value"
          label={t("measurements.valueWithUnit", {
            unit: typeInfo
              ? "unitKey" in typeInfo
                ? t(typeInfo.unitKey)
                : typeInfo.unit
              : "",
          })}
        >
          <Input
            id="value"
            type="number"
            enterKeyHint="next"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              typeInfo && "placeholder" in typeInfo
                ? typeInfo.placeholder
                : undefined
            }
            required
            aria-required="true"
            aria-invalid={!!error || undefined}
            aria-describedby={errorDescriptor}
          />
        </FieldGroup>
      )}

      {isGlucoseMode && (
        <FieldGroup
          htmlFor="glucose-context"
          label={t("measurements.glucoseContext")}
        >
          <Select
            value={glucoseContext}
            onValueChange={(v) => setGlucoseContext(v as GlucoseContextValue)}
          >
            <SelectTrigger id="glucose-context">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GLUCOSE_CONTEXTS.map((ctx) => (
                <SelectItem key={ctx.value} value={ctx.value}>
                  {t(ctx.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldGroup>
      )}

      <FieldGroup
        htmlFor="measuredAt"
        label={t("measurements.timestamp")}
        // v1.17.1 — surface that the timestamp is editable. The picker
        // already defaults to now and accepts any earlier instant; many
        // users never notice they can backdate a reading.
        hint={t("measurements.timestampBackdateHint")}
      >
        <DateTimeField
          id="measuredAt"
          value={measuredAt}
          onChange={setMeasuredAt}
          // v1.17 W1b — mirror the server-side plausibility bound: the
          // picker cannot select a future instant. Matches the
          // `validateEntryInstant` refine on `measuredAt`.
          max={getDefaultMeasuredAtValue()}
          required
          aria-required="true"
          aria-invalid={!!error || undefined}
          aria-describedby={errorDescriptor}
        />
      </FieldGroup>

      <FieldGroup
        htmlFor="notes"
        label={
          <>
            {t("measurements.notes")}{" "}
            <span className="text-muted-foreground font-normal">
              ({t("common.optional")})
            </span>
          </>
        }
        labelAccessory={
          <span className="text-muted-foreground text-xs">
            {notes.length}/{MAX_COMMENT_LENGTH}
          </span>
        }
      >
        <Input
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("measurements.notesPlaceholder")}
          maxLength={MAX_COMMENT_LENGTH}
          enterKeyHint="done"
          autoCapitalize="sentences"
        />
      </FieldGroup>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
