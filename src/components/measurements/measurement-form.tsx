"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import { invalidateKeys, measurementDependentKeys } from "@/lib/query-keys";

const MAX_COMMENT_LENGTH = 25;

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
] as const;

const GLUCOSE_CONTEXTS = [
  { value: "FASTING", labelKey: "measurements.glucoseContextFasting" },
  { value: "POSTPRANDIAL", labelKey: "measurements.glucoseContextPostprandial" },
  { value: "RANDOM", labelKey: "measurements.glucoseContextRandom" },
  { value: "BEDTIME", labelKey: "measurements.glucoseContextBedtime" },
] as const;

type GlucoseContextValue = (typeof GLUCOSE_CONTEXTS)[number]["value"];

interface MeasurementFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  defaultType?: string;
}

function getDefaultMeasuredAtValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function MeasurementForm({
  onSuccess,
  onCancel,
  defaultType,
}: MeasurementFormProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Normalize legacy BP types to combined mode
  const normalizedDefault =
    defaultType === "BLOOD_PRESSURE_SYS" || defaultType === "BLOOD_PRESSURE_DIA"
      ? "BLOOD_PRESSURE"
      : defaultType;

  const [type, setType] = useState(normalizedDefault || "BLOOD_PRESSURE");
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

        const res = await fetch("/api/measurements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });

        const json = await res.json();
        if (!res.ok) {
          setError(json.error);
          setLoading(false);
          return;
        }
      } else {
        // Single measurement
        const res = await fetch("/api/measurements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            value: parseFloat(value),
            measuredAt: timestamp,
            notes: notes || undefined,
            ...(isGlucoseMode ? { glucoseContext } : {}),
          }),
        });

        const json = await res.json();
        if (!res.ok) {
          setError(json.error);
          setLoading(false);
          return;
        }
      }

      // Reset form
      setValue("");
      setSysBp("");
      setDiaBp("");
      setPulse("");
      setNotes("");
      await invalidateKeys(queryClient, measurementDependentKeys);
      toast.success(t("common.saved"));
      onSuccess?.();
    } catch {
      setError(t("measurements.saveError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3">
        <Label htmlFor="measurement-type" className="shrink-0">
          {t("measurements.type")}
        </Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="measurement-type" className="flex-1">
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
      </div>

      {isBpMode ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sys">{t("measurements.systolicLabel")}</Label>
            <Input
              id="sys"
              type="number"
              step="1"
              value={sysBp}
              onChange={(e) => setSysBp(e.target.value)}
              placeholder="120"
              required
              min={60}
              max={280}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dia">{t("measurements.diastolicLabel")}</Label>
            <Input
              id="dia"
              type="number"
              step="1"
              value={diaBp}
              onChange={(e) => setDiaBp(e.target.value)}
              placeholder="80"
              required
              min={30}
              max={200}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="puls">{t("measurements.pulseLabel")}</Label>
            <Input
              id="puls"
              type="number"
              step="1"
              value={pulse}
              onChange={(e) => setPulse(e.target.value)}
              placeholder="72"
              min={30}
              max={220}
            />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="value">
            {t("measurements.valueWithUnit", {
              unit: typeInfo
                ? "unitKey" in typeInfo
                  ? t(typeInfo.unitKey)
                  : typeInfo.unit
                : "",
            })}
          </Label>
          <Input
            id="value"
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              typeInfo && "placeholder" in typeInfo
                ? typeInfo.placeholder
                : undefined
            }
            required
          />
        </div>
      )}

      {isGlucoseMode && (
        <div className="space-y-2">
          <Label htmlFor="glucose-context">
            {t("measurements.glucoseContext")}
          </Label>
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
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="measuredAt">{t("measurements.timestamp")}</Label>
        <Input
          id="measuredAt"
          type="datetime-local"
          value={measuredAt}
          onChange={(e) => setMeasuredAt(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="notes">
            {t("measurements.notes")}{" "}
            <span className="text-muted-foreground font-normal">
              ({t("common.optional")})
            </span>
          </Label>
          <span className="text-muted-foreground text-xs">
            {notes.length}/{MAX_COMMENT_LENGTH}
          </span>
        </div>
        <Input
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t("measurements.notesPlaceholder")}
          maxLength={MAX_COMMENT_LENGTH}
        />
      </div>

      {error && (
        <div role="alert" aria-live="assertive" className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-9 w-9"
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
          <Button type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            {t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
