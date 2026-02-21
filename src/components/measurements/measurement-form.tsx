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

const MAX_COMMENT_LENGTH = 25;

const MEASUREMENT_TYPES = [
  { value: "BLOOD_PRESSURE", label: "Blutdruck", unit: "mmHg" },
  { value: "WEIGHT", label: "Gewicht", unit: "kg", placeholder: "75.5" },
  { value: "PULSE", label: "Puls", unit: "bpm", placeholder: "72" },
  { value: "BODY_FAT", label: "Körperfett", unit: "%", placeholder: "22" },
  {
    value: "SLEEP_DURATION",
    label: "Schlaf",
    unit: "Stunden",
    placeholder: "7.5",
  },
  {
    value: "ACTIVITY_STEPS",
    label: "Schritte",
    unit: "Schritte",
    placeholder: "8000",
  },
] as const;

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeInfo = MEASUREMENT_TYPES.find((t) => t.value === type);
  const isBpMode = type === "BLOOD_PRESSURE";

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
      await queryClient.invalidateQueries({ queryKey: ["measurements"] });
      onSuccess?.();
    } catch {
      setError("Fehler beim Speichern");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center gap-3">
        <Label htmlFor="measurement-type" className="shrink-0">
          Typ
        </Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="measurement-type" className="flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEASUREMENT_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isBpMode ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sys">Systolisch (mmHg)</Label>
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
            <Label htmlFor="dia">Diastolisch (mmHg)</Label>
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
            <Label htmlFor="puls">Puls (bpm)</Label>
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
          <Label htmlFor="value">Wert {typeInfo && `(${typeInfo.unit})`}</Label>
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

      <div className="space-y-2">
        <Label htmlFor="measuredAt">Zeitpunkt</Label>
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
            Notizen{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <span className="text-muted-foreground text-xs">
            {notes.length}/{MAX_COMMENT_LENGTH}
          </span>
        </div>
        <Input
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="z.B. nach dem Essen"
          maxLength={MAX_COMMENT_LENGTH}
        />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
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
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={resetForm}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Formular zurücksetzen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
              Abbrechen
            </Button>
          )}
          <Button type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Speichern
          </Button>
        </div>
      </div>
    </form>
  );
}
