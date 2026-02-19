"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus, Trash2, X } from "lucide-react";

interface Schedule {
  windowStart: string;
  windowEnd: string;
  label: string;
  dose: string;
}

interface MedicationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  initial?: {
    id: string;
    name: string;
    dose: string;
    category: "BLOOD_PRESSURE" | "VITAMIN" | "OTHER";
    active: boolean;
    schedules: Schedule[];
  };
}

const DEFAULT_SCHEDULE: Schedule = {
  windowStart: "08:00",
  windowEnd: "09:00",
  label: "",
  dose: "",
};

function parseTimeToMinutes(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function sortSchedules(list: Schedule[]): Schedule[] {
  return [...list]
    .map((schedule, index) => ({ schedule, index }))
    .sort((a, b) => {
      const aStart = parseTimeToMinutes(a.schedule.windowStart);
      const bStart = parseTimeToMinutes(b.schedule.windowStart);

      if (aStart === null && bStart === null) return a.index - b.index;
      if (aStart === null) return 1;
      if (bStart === null) return -1;
      if (aStart !== bStart) return aStart - bStart;

      const aEnd = parseTimeToMinutes(a.schedule.windowEnd);
      const bEnd = parseTimeToMinutes(b.schedule.windowEnd);
      if (aEnd === null && bEnd === null) return a.index - b.index;
      if (aEnd === null) return 1;
      if (bEnd === null) return -1;
      if (aEnd !== bEnd) return aEnd - bEnd;

      return a.index - b.index;
    })
    .map((item) => item.schedule);
}

export function MedicationForm({
  onSuccess,
  onCancel,
  initial,
}: MedicationFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");
  const [dose, setDose] = useState(initial?.dose ?? "");
  const [category, setCategory] = useState<
    "BLOOD_PRESSURE" | "VITAMIN" | "OTHER"
  >(initial?.category ?? "OTHER");
  const [active, setActive] = useState(initial?.active ?? true);
  const [schedules, setSchedules] = useState<Schedule[]>(
    sortSchedules(
      initial?.schedules.length ? initial.schedules : [{ ...DEFAULT_SCHEDULE }],
    ),
  );
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!initial;

  function updateSchedule(index: number, field: keyof Schedule, value: string) {
    setSchedules((prev) =>
      sortSchedules(
        prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
      ),
    );
  }

  function addSchedule() {
    setSchedules((prev) => sortSchedules([...prev, { ...DEFAULT_SCHEDULE }]));
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
        body: JSON.stringify({
          name,
          dose,
          category,
          ...(isEdit ? { active } : {}),
          schedules: sortSchedules(schedules).map((s) => ({
            ...s,
            dose: s.dose || undefined,
          })),
        }),
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

  async function handleDelete() {
    if (!initial) return;
    if (!confirm("Medikament wirklich löschen?")) return;

    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? "Fehler beim Löschen");
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["medications"] });
      onSuccess?.();
    } catch {
      setError("Fehler beim Löschen");
    } finally {
      setDeleting(false);
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

      <div className="space-y-2">
        <Label htmlFor="med-category">Typ</Label>
        <select
          id="med-category"
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as "BLOOD_PRESSURE" | "VITAMIN" | "OTHER")
          }
          className="border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <option value="BLOOD_PRESSURE">Blutdrucksenker</option>
          <option value="VITAMIN">Vitamine</option>
          <option value="OTHER">Sonstiges</option>
        </select>
      </div>

      {isEdit && (
        <div className="bg-muted/40 flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Medikament aktiv</p>
            <p className="text-muted-foreground text-xs">
              Deaktivierte Medikamente werden separat angezeigt.
            </p>
          </div>
          <Switch
            checked={active}
            onCheckedChange={setActive}
            disabled={loading || deleting}
            aria-label="Medikament aktiv"
          />
        </div>
      )}

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
                type="text"
                inputMode="numeric"
                pattern="[0-2][0-9]:[0-5][0-9]"
                placeholder="08:00"
                value={s.windowStart}
                onChange={(e) =>
                  updateSchedule(i, "windowStart", e.target.value)
                }
                required
                maxLength={5}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Bis</Label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-2][0-9]:[0-5][0-9]"
                placeholder="09:00"
                value={s.windowEnd}
                onChange={(e) => updateSchedule(i, "windowEnd", e.target.value)}
                required
                maxLength={5}
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
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Dosis</Label>
              <Input
                value={s.dose}
                onChange={(e) => updateSchedule(i, "dose", e.target.value)}
                placeholder={dose || "Standard"}
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
        <Button type="submit" disabled={loading || deleting}>
          {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isEdit ? "Speichern" : "Medikament anlegen"}
        </Button>
        {isEdit && (
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={loading || deleting}
          >
            {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {!deleting && <Trash2 className="mr-2 h-4 w-4" />}
            Löschen
          </Button>
        )}
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={loading || deleting}
          >
            Abbrechen
          </Button>
        )}
      </div>
    </form>
  );
}
