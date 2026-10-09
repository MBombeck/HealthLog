/**
 * "Gehört dieser Scan zu einer Impfung?" — the same rule the visit suggestion
 * uses, applied to the dose direction.
 *
 * A document classified `VACCINATION` arriving in the vault offers to file
 * itself against a dose recorded around the same date. The rule is NOT
 * re-invented here: the window is the encounter suggestion's exported constant
 * (`ENCOUNTER_SUGGEST_WINDOW_DAYS`), so the two moments cannot drift to
 * different windows, and the verdict shape is the same discriminated union:
 *
 *   exactly one  → pre-select it, visibly, with one undo
 *   two or more  → offer a picker with NOTHING pre-selected
 *   zero         → offer nothing at all
 *
 * The middle branch is the whole point. Pre-selecting the first of two is the
 * failure that teaches a person to stop reading suggestions; this module
 * returns the SHAPE of the answer, and a caller cannot collapse "many" into
 * "one" without writing the collapse itself. Breaking that is the watched-red
 * this moment owes (WR-8).
 *
 * It never blocks an upload: every caller treats the verdict as an offer, and
 * the filing works ignored, dismissed, or never rendered.
 *
 * When the shared filing-moment module from the visits milestone lands on
 * `main`, this moment registers with it and this file collapses into that
 * registration; until then it holds the same spec locally, and the window
 * import is what keeps the two honest.
 */
import type { Prisma } from "@/generated/prisma/client";

import { ENCOUNTER_SUGGEST_WINDOW_DAYS } from "@/lib/encounters/suggest-window";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Above one already means "offer a picker", so the exact count past this cap changes nothing. */
const MAX_CANDIDATES = 20;

/** One candidate dose, resolved enough to render without a second round trip. */
export interface VaccinationSuggestion {
  id: string;
  occurredAt: string;
  /** The catalogue slug when the dose carries one, for the client to name it. */
  antigenSlug: string | null;
  /** The person's own wording, when that is all the dose has. */
  vaccineName: string | null;
}

export type VaccinationSuggestionResult =
  | { kind: "one"; vaccination: VaccinationSuggestion }
  | { kind: "many"; vaccinations: VaccinationSuggestion[] }
  | { kind: "none" };

/** The window around an anchor, inclusive on both edges — same width as the visit moment. */
export function vaccinationSuggestWindow(anchor: Date): {
  from: Date;
  to: Date;
} {
  const half = ENCOUNTER_SUGGEST_WINDOW_DAYS * DAY_MS;
  return {
    from: new Date(anchor.getTime() - half),
    to: new Date(anchor.getTime() + half),
  };
}

/**
 * Resolve the dose a document dated `anchor` most plausibly belongs to.
 *
 * `userId` is the caller's resolved record id, fed straight to the `where`;
 * this module never accepts one from a request body.
 */
export async function suggestVaccinationForDate(
  tx: Prisma.TransactionClient,
  input: { userId: string; anchor: Date },
): Promise<VaccinationSuggestionResult> {
  if (Number.isNaN(input.anchor.getTime())) return { kind: "none" };

  const { from, to } = vaccinationSuggestWindow(input.anchor);

  const rows = await tx.vaccinationRecord.findMany({
    where: {
      userId: input.userId,
      deletedAt: null,
      occurredAt: { gte: from, lte: to },
    },
    orderBy: { occurredAt: "asc" },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      occurredAt: true,
      antigenSlug: true,
      vaccineName: true,
      // v1.42 (#1005) — a dose named only by the person's own definition is
      // offered under that definition's name.
      customVaccine: { select: { name: true, deletedAt: true } },
    },
  });

  const vaccinations: VaccinationSuggestion[] = rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    antigenSlug: row.antigenSlug,
    vaccineName:
      row.vaccineName ??
      (row.customVaccine && row.customVaccine.deletedAt === null
        ? row.customVaccine.name
        : null),
  }));

  if (vaccinations.length === 0) return { kind: "none" };
  if (vaccinations.length === 1) {
    return { kind: "one", vaccination: vaccinations[0]! };
  }
  return { kind: "many", vaccinations };
}
