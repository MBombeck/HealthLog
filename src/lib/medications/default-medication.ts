import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

export interface DefaultMedicationOption {
  id: string;
  name: string;
  active: boolean;
  /**
   * The server's answer to "does this medication offer a dose today"
   * (`src/lib/medications/intake-actionable.ts`): active, intake tracked,
   * and the course includes today. The preselection reads it and never
   * re-derives it from `active`, so an ended course is never the default.
   */
  intakeActionable: boolean;
  /**
   * The server's display-due slot (`GET /api/medications`): the open slot
   * while it is still due or overdue, else the next one.
   */
  nextDueAt?: string | null;
  nextDueOverdue?: boolean;
}

/**
 * Pick the medication that should be pre-selected when an intake form opens.
 * Only a medication that offers a dose today (`intakeActionable`) can be the
 * default. Among those, the server's display-due slot decides: an overdue
 * dose first, then the earliest dose of today; otherwise the fallback is the
 * single candidate or the first name alphabetically. The picker does no
 * window arithmetic of its own. A list may still carry ended courses for
 * back-filling a past dose; they stay pickable by hand but are never
 * preselected.
 */
export function pickDefaultMedicationId(
  options: DefaultMedicationOption[],
  now: Date = new Date(),
  tz: string = DEFAULT_TIMEZONE,
): string | null {
  const actives = options.filter((medication) => medication.intakeActionable);
  if (actives.length === 0) return null;
  if (actives.length === 1) return actives[0].id;

  const today = userDayKey(now, tz);
  const earliest = (
    pick: (m: DefaultMedicationOption, at: number) => boolean,
  ): string | null => {
    let best: { id: string; at: number } | null = null;
    for (const m of actives) {
      const at = m.nextDueAt ? Date.parse(m.nextDueAt) : Number.NaN;
      if (!Number.isFinite(at) || !pick(m, at)) continue;
      if (best === null || at < best.at) best = { id: m.id, at };
    }
    return best?.id ?? null;
  };
  const due =
    earliest((m) => m.nextDueOverdue === true) ??
    earliest((_, at) => userDayKey(new Date(at), tz) === today);
  if (due) return due;

  const sorted = [...actives].sort((a, b) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
  );
  return sorted[0]?.id ?? null;
}

/**
 * Keep an explicit picker choice across data-driven re-renders. Until the user
 * chooses, the due-aware default remains derived from the latest read DTO.
 */
export function resolveMedicationSelectionId(
  options: DefaultMedicationOption[],
  userSelection: string | null,
  now: Date = new Date(),
  tz: string = DEFAULT_TIMEZONE,
): string | null {
  return userSelection ?? pickDefaultMedicationId(options, now, tz);
}
