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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  BellOff,
  Eraser,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { formatTimeWindowRange } from "@/lib/time-window-format";

const DOSE_UNITS = [
  "mg",
  "g",
  "ml",
  "Tropfen",
  "Tablette(n)",
  "Kapsel(n)",
  "Stück",
  "IE",
  "µg",
] as const;

const DAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"] as const;
const DAY_LABELS_LONG = [
  "Sonntags",
  "Montags",
  "Dienstags",
  "Mittwochs",
  "Donnerstags",
  "Freitags",
  "Samstags",
] as const;

function getNextRecurrenceDate(schedule: Schedule): Date | null {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const startWeekIndex = Math.floor(start.getTime() / weekMs);

  for (let offset = 0; offset <= 400; offset++) {
    const candidate = new Date(start);
    candidate.setDate(start.getDate() + offset);

    const candidateWeekIndex = Math.floor(candidate.getTime() / weekMs);
    const isIntervalWeek =
      schedule.intervalWeeks <= 1 ||
      candidateWeekIndex % schedule.intervalWeeks ===
        startWeekIndex % schedule.intervalWeeks;
    if (!isIntervalWeek) continue;

    if (
      schedule.daysOfWeek.length === 0 ||
      schedule.daysOfWeek.includes(candidate.getDay())
    ) {
      return candidate;
    }
  }

  return null;
}

function formatRecurrenceSummary(schedule: Schedule): string {
  const dayText =
    schedule.daysOfWeek.length === 0
      ? "Täglich"
      : schedule.daysOfWeek.length === 1
        ? DAY_LABELS_LONG[schedule.daysOfWeek[0]]
        : schedule.daysOfWeek.map((day) => DAY_LABELS[day]).join(", ");
  const intervalText =
    schedule.intervalWeeks === 1
      ? "jede Woche"
      : `alle ${schedule.intervalWeeks} Wochen`;
  return `Intervall: ${dayText} - ${intervalText}`;
}

function formatNextWindowSummary(schedule: Schedule): string {
  const isSimpleDaily =
    schedule.daysOfWeek.length === 0 && schedule.intervalWeeks === 1;
  if (isSimpleDaily) {
    return `Nächstes Zeitfenster: täglich, ${formatTimeWindowRange(schedule.windowStart, schedule.windowEnd)}`;
  }

  const nextDate = getNextRecurrenceDate(schedule);
  const nextText = nextDate
    ? `${new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
      }).format(nextDate)}, ${formatTimeWindowRange(schedule.windowStart, schedule.windowEnd)}`
    : "—";
  return `Nächstes Zeitfenster: ${nextText}`;
}

interface Schedule {
  windowStart: string;
  windowEnd: string;
  label: string;
  dose: string;
  daysOfWeek: number[];
  intervalWeeks: number;
  showAdvanced: boolean;
}

interface MedicationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  editActions?: {
    onImportIntakes: () => void;
    onApiAccess: () => void;
  };
  initial?: {
    id: string;
    name: string;
    dose: string;
    category: string;
    active: boolean;
    notificationsEnabled?: boolean;
    schedules: Array<{
      windowStart: string;
      windowEnd: string;
      label: string;
      dose: string;
      daysOfWeek?: number[];
      intervalWeeks?: number;
    }>;
  };
}

const DEFAULT_SCHEDULE: Schedule = {
  windowStart: "08:00",
  windowEnd: "09:00",
  label: "",
  dose: "",
  daysOfWeek: [],
  intervalWeeks: 1,
  showAdvanced: false,
};

/** Try to split "400mg" into ["400", "mg"] */
function parseDose(dose: string): { amount: string; unit: string } {
  const match = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(dose.trim());
  if (match) return { amount: match[1], unit: match[2] };
  return { amount: "", unit: dose };
}

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
  editActions,
  initial,
}: MedicationFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial?.name ?? "");

  const initialDose = parseDose(initial?.dose ?? "");
  const [doseAmount, setDoseAmount] = useState(initialDose.amount);
  const [doseUnit, setDoseUnit] = useState(initialDose.unit);

  const [category, setCategory] = useState(initial?.category ?? "OTHER");
  const [active, setActive] = useState(initial?.active ?? true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    initial?.notificationsEnabled ?? true,
  );
  const [schedules, setSchedules] = useState<Schedule[]>(
    sortSchedules(
      initial?.schedules.length
        ? initial.schedules.map((s) => {
            const recurrence = {
              daysOfWeek: s.daysOfWeek ?? [],
              intervalWeeks: s.intervalWeeks ?? 1,
            };
            const hasCustomRecurrence =
              recurrence.daysOfWeek.length > 0 || recurrence.intervalWeeks > 1;
            return {
              ...s,
              daysOfWeek: recurrence.daysOfWeek,
              intervalWeeks: recurrence.intervalWeeks,
              showAdvanced: hasCustomRecurrence,
            };
          })
        : [{ ...DEFAULT_SCHEDULE }],
    ),
  );
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purging, setPurging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);

  const isEdit = !!initial;
  const dose = doseAmount
    ? `${doseAmount}${doseUnit ? ` ${doseUnit}` : ""}`
    : doseUnit;

  function updateSchedule(
    index: number,
    field: keyof Schedule,
    value: string | number[] | number | boolean,
  ) {
    setSchedules((prev) =>
      sortSchedules(
        prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
      ),
    );
  }

  function toggleDay(scheduleIndex: number, day: number) {
    setSchedules((prev) =>
      prev.map((s, i) => {
        if (i !== scheduleIndex) return s;
        const days = s.daysOfWeek.includes(day)
          ? s.daysOfWeek.filter((d) => d !== day)
          : [...s.daysOfWeek, day].sort();
        return { ...s, daysOfWeek: days };
      }),
    );
  }

  function addSchedule() {
    setSchedules((prev) => sortSchedules([...prev, { ...DEFAULT_SCHEDULE }]));
  }

  function toggleAdvanced(scheduleIndex: number) {
    setSchedules((prev) =>
      prev.map((s, i) =>
        i === scheduleIndex ? { ...s, showAdvanced: !s.showAdvanced } : s,
      ),
    );
  }

  function removeSchedule(index: number) {
    if (schedules.length <= 1) return;
    setSchedules((prev) => prev.filter((_, i) => i !== index));
  }

  function resetCreateForm() {
    if (isEdit) return;
    setName("");
    setDoseAmount("");
    setDoseUnit("");
    setCategory("OTHER");
    setActive(true);
    setNotificationsEnabled(true);
    setSchedules([{ ...DEFAULT_SCHEDULE }]);
    setError(null);
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
          ...(isEdit
            ? {
                active,
                ...(notificationsEnabled !==
                  (initial?.notificationsEnabled ?? true) && {
                  notificationsEnabled,
                }),
              }
            : {}),
          schedules: sortSchedules(schedules).map((s) => ({
            windowStart: s.windowStart,
            windowEnd: s.windowEnd,
            label: s.label || undefined,
            dose: s.dose || undefined,
            daysOfWeek: s.daysOfWeek.length > 0 ? s.daysOfWeek : undefined,
            intervalWeeks: s.intervalWeeks,
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

  async function handlePurge() {
    if (!initial) return;
    setError(null);
    setPurging(true);
    try {
      const res = await fetch(`/api/medications/${initial.id}/intake/purge`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? "Fehler beim Löschen der Aufzeichnungen");
        return;
      }

      await queryClient.invalidateQueries({ queryKey: ["medications"] });
      setPurgeDialogOpen(false);
    } catch {
      setError("Fehler beim Löschen der Aufzeichnungen");
    } finally {
      setPurging(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
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

      <div className="space-y-1.5">
        <Label htmlFor="med-category">Typ</Label>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger id="med-category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="BLOOD_PRESSURE">Blutdrucksenker</SelectItem>
            <SelectItem value="VITAMIN">Vitamine</SelectItem>
            <SelectItem value="SUPPLEMENT">Nahrungsergänzung</SelectItem>
            <SelectItem value="PAIN_RELIEF">Schmerzmittel</SelectItem>
            <SelectItem value="ALLERGY">Allergie</SelectItem>
            <SelectItem value="DIGESTIVE">Magen/Darm</SelectItem>
            <SelectItem value="THYROID">Schilddrüse</SelectItem>
            <SelectItem value="HORMONE">Hormone</SelectItem>
            <SelectItem value="SKIN">Hautpflege</SelectItem>
            <SelectItem value="SLEEP_AID">Schlafmittel</SelectItem>
            <SelectItem value="OTHER">Sonstiges</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-amount">Dosis</Label>
          <Input
            id="med-dose-amount"
            type="text"
            inputMode="decimal"
            value={doseAmount}
            onChange={(e) => setDoseAmount(e.target.value)}
            placeholder="z.B. 400"
            required
            maxLength={20}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="med-dose-unit">Einheit</Label>
          <Input
            id="med-dose-unit"
            list="dose-units"
            value={doseUnit}
            onChange={(e) => setDoseUnit(e.target.value)}
            placeholder="mg"
            maxLength={30}
            className="w-full"
          />
        </div>
      </div>
      <datalist id="dose-units">
        {DOSE_UNITS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>

      <div className="space-y-2">
        <div className="flex h-8 items-center justify-between">
          <Label className="text-sm leading-none">Zeitfenster</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8"
            onClick={addSchedule}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Neues Zeitfenster
          </Button>
        </div>

        {schedules.map((s, i) => (
          <div
            key={i}
            className="bg-card border-border/70 rounded-xl border p-3.5"
          >
            <div className="flex items-center justify-between">
              <p className="flex-1 pr-2 pl-1 text-xs leading-5 break-words">
                <span className="font-medium">
                  {s.label.trim() || `Zeitfenster ${i + 1}`}
                </span>{" "}
                <span className="font-normal text-foreground/70">
                  ({formatNextWindowSummary(s)})
                </span>
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => toggleAdvanced(i)}>
                    <Settings2 className="mr-2 h-4 w-4" />
                    {s.showAdvanced
                      ? "Erweiterte Bearbeitung ausblenden"
                      : "Erweiterte Bearbeitung"}
                  </DropdownMenuItem>
                  {schedules.length > 1 && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => removeSchedule(i)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Zeitfenster entfernen
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="mt-1 grid items-end gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">Von</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-2][0-9]:[0-5][0-9]"
                  placeholder="08:00"
                  value={s.windowStart}
                  className="h-8 text-xs md:text-xs"
                  onChange={(e) =>
                    updateSchedule(i, "windowStart", e.target.value)
                  }
                  required
                  maxLength={5}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">Bis</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-2][0-9]:[0-5][0-9]"
                  placeholder="09:00"
                  value={s.windowEnd}
                  className="h-8 text-xs md:text-xs"
                  onChange={(e) =>
                    updateSchedule(i, "windowEnd", e.target.value)
                  }
                  required
                  maxLength={5}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">Bezeichnung</Label>
                <Input
                  value={s.label}
                  className="h-8 text-xs md:text-xs"
                  onChange={(e) => updateSchedule(i, "label", e.target.value)}
                  placeholder="z.B. Morgens"
                  maxLength={50}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-normal">Dosis</Label>
                <Input
                  value={s.dose}
                  className="h-8 text-xs md:text-xs"
                  onChange={(e) => updateSchedule(i, "dose", e.target.value)}
                  placeholder={dose || "Standard"}
                  maxLength={50}
                />
              </div>
            </div>
            {s.showAdvanced && (
              <p className="text-muted-foreground mt-2 pl-1 text-xs leading-4">
                {formatRecurrenceSummary(s)}
              </p>
            )}

            {/* Day-of-week selection */}
            {s.showAdvanced && (
              <div className="border-border/60 mt-2.5 space-y-2.5 border-t pt-2.5">
                <div className="space-y-1.5">
                  <Label className="text-sm">Intervall</Label>
                  <div className="grid grid-cols-4 gap-1">
                    {[1, 2, 3, 4].map((weeks) => (
                      <button
                        key={weeks}
                        type="button"
                        onClick={() => updateSchedule(i, "intervalWeeks", weeks)}
                        className={`h-8 rounded-md border text-xs font-medium transition-colors ${
                          s.intervalWeeks === weeks
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border/70 bg-muted text-foreground/70 hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        {weeks}W
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-sm">Tage</Label>
                  <div className="flex w-full gap-1">
                    <button
                      type="button"
                      onClick={() => updateSchedule(i, "daysOfWeek", [])}
                      className={`h-8 min-w-24 rounded-md border px-3 text-xs font-medium transition-colors ${
                        s.daysOfWeek.length === 0
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border/70 bg-muted text-foreground/70 hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      Täglich
                    </button>
                    {DAY_LABELS.map((label, dayIndex) => {
                      const isSelected = s.daysOfWeek.includes(dayIndex);
                      return (
                        <button
                          key={dayIndex}
                          type="button"
                          onClick={() => toggleDay(i, dayIndex)}
                          className={`h-8 flex-1 rounded-md border text-xs font-medium transition-colors ${
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border/70 bg-muted text-foreground/60 hover:bg-accent hover:text-foreground"
                          }`}
                          title={
                            s.daysOfWeek.includes(dayIndex)
                              ? `${label} deaktivieren`
                              : `${label} aktivieren`
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
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
              disabled={loading || deleting}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {isEdit ? (
              <>
                {editActions && (
                  <>
                    <DropdownMenuItem onClick={editActions.onImportIntakes}>
                      <Upload className="mr-2 h-4 w-4" />
                      Einnahmen importieren
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={editActions.onApiAccess}>
                      <Terminal className="mr-2 h-4 w-4" />
                      API-Endpunkt
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => setActive((prev) => !prev)}>
                  {active ? (
                    <Pause className="mr-2 h-4 w-4" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  {active ? "Pausieren" : "Aktivieren"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setNotificationsEnabled((prev) => !prev)}
                >
                  {notificationsEnabled ? (
                    <BellOff className="mr-2 h-4 w-4" />
                  ) : (
                    <Bell className="mr-2 h-4 w-4" />
                  )}
                  {notificationsEnabled
                    ? "Benachrichtigungen deaktivieren"
                    : "Benachrichtigungen aktivieren"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setPurgeDialogOpen(true)}
                >
                  <Eraser className="mr-2 h-4 w-4" />
                  Alle Aufzeichnungen löschen
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Löschen
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={resetCreateForm}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Formular zurücksetzen
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={loading || deleting}
            >
              Abbrechen
            </Button>
          )}
          <Button type="submit" disabled={loading || deleting}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? "Speichern" : "Medikament anlegen"}
          </Button>
        </div>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Medikament löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Das Medikament und die gesamte Einnahme-Historie werden
              unwiderruflich gelöscht.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={purgeDialogOpen} onOpenChange={setPurgeDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Alle Aufzeichnungen löschen?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Alle Einnahme-Aufzeichnungen für dieses Medikament werden
              unwiderruflich gelöscht. Das Medikament selbst bleibt bestehen
              und startet ohne Verlaufsdaten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>
              Abbrechen
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handlePurge}
              disabled={purging}
            >
              {purging ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Alle Aufzeichnungen löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
