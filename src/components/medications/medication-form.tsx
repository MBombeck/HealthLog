"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, X } from "lucide-react";

interface Schedule {
  windowStart: string;
  windowEnd: string;
  label: string;
}

interface MedicationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  initial?: {
    id: string;
    name: string;
    dose: string;
    schedules: Schedule[];
  };
}

const DEFAULT_SCHEDULE: Schedule = {
  windowStart: "08:00",
  windowEnd: "09:00",
  label: "",
};

export function MedicationForm({
  onSuccess,
  onCancel,
  initial,
}: MedicationFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [dose, setDose] = useState(initial?.dose ?? "");
  const [schedules, setSchedules] = useState<Schedule[]>(
    initial?.schedules.length ? initial.schedules : [{ ...DEFAULT_SCHEDULE }],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!initial;

  function updateSchedule(index: number, field: keyof Schedule, value: string) {
    setSchedules((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    );
  }

  function addSchedule() {
    setSchedules((prev) => [...prev, { ...DEFAULT_SCHEDULE }]);
  }

  function removeSchedule(index: number) {
    if (schedules.length <= 1) return;
    setSchedules((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const url = isEdit ? `/api/medications/${initial.id}` : "/api/medications";
    const method = isEdit ? "PUT" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, dose, schedules }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error);
        setLoading(false);
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["medications"] });
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
          <Label htmlFor="med-name">Name</Label>
          <Input
            id="med-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z.B. Ibuprofen"
            required
            maxLength={100}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="med-dose">Dosis</Label>
          <Input
            id="med-dose"
            value={dose}
            onChange={(e) => setDose(e.target.value)}
            placeholder="z.B. 400mg"
            required
            maxLength={50}
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Zeitfenster</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addSchedule}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Zeitfenster
          </Button>
        </div>

        {schedules.map((s, i) => (
          <div
            key={i}
            className="bg-muted/50 flex items-end gap-2 rounded-lg p-3"
          >
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Von</Label>
              <Input
                type="time"
                value={s.windowStart}
                onChange={(e) =>
                  updateSchedule(i, "windowStart", e.target.value)
                }
                required
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Bis</Label>
              <Input
                type="time"
                value={s.windowEnd}
                onChange={(e) => updateSchedule(i, "windowEnd", e.target.value)}
                required
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Bezeichnung</Label>
              <Input
                value={s.label}
                onChange={(e) => updateSchedule(i, "label", e.target.value)}
                placeholder="z.B. Morgens"
                maxLength={50}
              />
            </div>
            {schedules.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive h-9 w-9 shrink-0"
                onClick={() => removeSchedule(i)}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={loading}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? "Speichern" : "Medikament anlegen"}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
      </div>
    </form>
  );
}
