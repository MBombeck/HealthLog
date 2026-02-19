"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus } from "lucide-react";

const MEASUREMENT_TYPES = [
  { value: "WEIGHT", label: "Gewicht", unit: "kg", placeholder: "75.5" },
  {
    value: "BLOOD_PRESSURE_SYS",
    label: "Blutdruck (Sys)",
    unit: "mmHg",
    placeholder: "120",
  },
  {
    value: "BLOOD_PRESSURE_DIA",
    label: "Blutdruck (Dia)",
    unit: "mmHg",
    placeholder: "80",
  },
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
  defaultType?: string;
}

export function MeasurementForm({
  onSuccess,
  defaultType,
}: MeasurementFormProps) {
  const queryClient = useQueryClient();
  const [type, setType] = useState(defaultType || "WEIGHT");
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  const [measuredAt, setMeasuredAt] = useState(() => {
    const now = new Date();
    // Format for datetime-local input in Europe/Berlin
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60 * 1000);
    return local.toISOString().slice(0, 16);
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeInfo = MEASUREMENT_TYPES.find((t) => t.value === type);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          value: parseFloat(value),
          measuredAt: new Date(measuredAt).toISOString(),
          notes: notes || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      setValue("");
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Typ</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger>
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

        <div className="space-y-2">
          <Label htmlFor="value">Wert {typeInfo && `(${typeInfo.unit})`}</Label>
          <Input
            id="value"
            type="number"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={typeInfo?.placeholder}
            required
          />
        </div>
      </div>

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
        <Label htmlFor="notes">
          Notizen{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="z.B. nach dem Essen"
          maxLength={500}
        />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <Button type="submit" disabled={loading}>
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        Messwert speichern
      </Button>
    </form>
  );
}
