/**
 * v1.38 — doctor-visit context block for the Coach snapshot.
 *
 * Lets the Coach know a visit is COMING (so it does not push a "book an
 * appointment" nudge at someone who already has one on the calendar) and what
 * the LAST one was about, without being handed a visit archive. A full visit
 * history is a `get_visits` question, not a prompt-budget one, so this block is
 * deliberately small:
 *
 *   - the upcoming appointments within a short horizon (14 days), and
 *   - the single most recent past visit that actually happened.
 *
 * Nothing more. The snapshot runs under a hard character cap that progressively
 * degrades low-priority clusters, and every added block competes with an
 * existing one; the block is registered against the lowest-priority cluster in
 * `snapshot.ts` so it is among the first shed when the cap binds.
 *
 * The two free-text columns are `Bytes` ciphertext and decrypt fail-soft: a
 * key-rotation gap on one row reads as a missing reason/outcome, not a thrown
 * snapshot build. Every free-text string that enters the prompt routes through
 * `sanitizeForPrompt` first, the same rule `labs-snapshot.ts` / `illness-
 * snapshot.ts` follow: a reason transcribed out of an uploaded document is
 * attacker-reachable, and the block is fenced as data at the prompt boundary.
 * The Coach reads these as context and never states a cause from them.
 *
 * No module gate: a visit is core (the reasoning is written at the `Encounter`
 * model). `userId` is narrowed from the authenticated session by the caller and
 * feeds the Prisma `where` field-by-field; it is never an input.
 */
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";

/** Upcoming appointments only count if they fall within this many days. */
const UPCOMING_HORIZON_DAYS = 14;

/** Cap on upcoming appointments carried, soonest first. */
const MAX_UPCOMING = 5;

/** Max chars of a visit's free-text reason / outcome that may enter the prompt. */
const MAX_TEXT_CHARS = 200;

/** Max chars of the practitioner name / specialty that may enter the prompt. */
const MAX_PRACTITIONER_CHARS = 80;

/** One visit, compacted for the prompt. */
export interface CoachVisitEntry {
  occurredAt: string;
  kind: string;
  /** Practitioner name, sanitised; null when the visit names no practice. */
  practitioner: string | null;
  /** Free-text specialty, sanitised; null when unset. */
  specialty: string | null;
  /** Why the person went / is going, decrypted + sanitised; null when unset. */
  reason: string | null;
  /** What came out of it, decrypted + sanitised; null (always) for an upcoming visit. */
  outcome: string | null;
  /**
   * Where on the body, decrypted + sanitised (v1.39.1). Present only when the
   * visit names a site, so the block does not grow for the visits that never
   * carry one.
   */
  bodySite?: string;
  /** The side of `bodySite`, when one is stated. */
  laterality?: string;
}

export interface CoachVisitsBlock {
  /** Appointments in the next `UPCOMING_HORIZON_DAYS` days, soonest first. */
  upcoming: CoachVisitEntry[];
  /** The single most recent visit that happened, or null when none has. */
  mostRecent: CoachVisitEntry | null;
}

/** A row shape the two reads share. */
interface EncounterRow {
  occurredAt: Date;
  kind: string;
  reasonEncrypted: Uint8Array | null;
  outcomeEncrypted: Uint8Array | null;
  bodySiteEncrypted?: Uint8Array | null;
  laterality?: string | null;
  practitioner: { name: string; specialty: string | null } | null;
}

/** Decrypt a `Bytes` free-text column, fail-soft to null, then bound + sanitise. */
function decryptText(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  let plaintext: string;
  try {
    plaintext = decryptFromBytes(value);
  } catch {
    return null;
  }
  const clean = sanitizeForPrompt(plaintext, MAX_TEXT_CHARS);
  return clean.length > 0 ? clean : null;
}

function toEntry(row: EncounterRow): CoachVisitEntry {
  const bodySite = decryptText(row.bodySiteEncrypted ?? null);
  return {
    occurredAt: row.occurredAt.toISOString(),
    kind: row.kind,
    practitioner: row.practitioner
      ? sanitizeForPrompt(row.practitioner.name, MAX_PRACTITIONER_CHARS)
      : null,
    specialty: row.practitioner?.specialty
      ? sanitizeForPrompt(row.practitioner.specialty, MAX_PRACTITIONER_CHARS)
      : null,
    reason: decryptText(row.reasonEncrypted),
    outcome: decryptText(row.outcomeEncrypted),
    ...(bodySite
      ? { bodySite, ...(row.laterality ? { laterality: row.laterality } : {}) }
      : {}),
  };
}

/**
 * Build the visits context block, or `null` when there is neither an upcoming
 * appointment inside the horizon nor a past visit on file. Selects only the
 * columns the block carries; the practitioner rides one relation include.
 */
export async function buildVisitsSnapshotBlock(
  userId: string,
  now: Date = new Date(),
): Promise<CoachVisitsBlock | null> {
  const horizon = new Date(now.getTime() + UPCOMING_HORIZON_DAYS * 86_400_000);
  const practitionerInclude = {
    practitioner: { select: { name: true, specialty: true } },
  } as const;

  const [upcomingRows, recentRow] = await Promise.all([
    // Booked appointments in the next 14 days, soonest first.
    prisma.encounter.findMany({
      where: {
        userId,
        deletedAt: null,
        status: "PLANNED",
        occurredAt: { gt: now, lte: horizon },
      },
      orderBy: { occurredAt: "asc" },
      take: MAX_UPCOMING,
      include: practitionerInclude,
    }),
    // The single most recent visit that actually happened. A cancelled visit
    // or a no-show is not "the last time I saw a doctor", so only DONE counts.
    prisma.encounter.findFirst({
      where: {
        userId,
        deletedAt: null,
        status: "DONE",
        occurredAt: { lte: now },
      },
      orderBy: { occurredAt: "desc" },
      include: practitionerInclude,
    }),
  ]);

  if (upcomingRows.length === 0 && !recentRow) return null;

  return {
    upcoming: upcomingRows.map(toEntry),
    mostRecent: recentRow ? toEntry(recentRow) : null,
  };
}
