/**
 * The record side of a day: what ran through it and what happened on it,
 * section by section (v1.42, #613).
 *
 * Every read is bounded to the day and indexed on `(userId, time field)`.
 * A day is stored three ways in this schema, and each reader below uses the
 * one its table speaks:
 *
 *   - **an instant** (`takenAt`, `occurredAt`, `onsetAt`, `startedAt`): the
 *     half-open local window `[dayStart, dayEnd)` in the record's zone, 23,
 *     24 or 25 hours long;
 *   - **a date string with its own zone** (mood, illness day logs, cycle):
 *     equality on the string, because the row already decided which day it
 *     belongs to and a second derivation could disagree with it; a
 *     screener's `takenAt` is cut in its own `tz` the same way;
 *   - **a calendar date** (`@db.Date` medication and course bounds, a
 *     document's stated date stored at noon UTC): compared as a date key,
 *     never through a zone.
 *
 * Free text is decrypted here for the caller that resolved the record and
 * nowhere else. A value that cannot be decrypted is `null` with a warning on
 * the request's event, never the ciphertext and never a blank that looks
 * like "no note".
 */
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import type {
  DayEvent,
  DayRunningItem,
  DaySectionKey,
} from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import { listTargetsBySource } from "@/lib/links/link-service";
import { getEvent } from "@/lib/logging/context";
import { lastDayCovered } from "@/lib/life-events/dates";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";
import { effectiveMoodTz } from "@/lib/mood/date-key";
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { daysBetweenDateKeys, shiftDateKey, userDayKey } from "@/lib/tz/format";

/** Everything a section reader needs about the day. */
export interface DayFrame {
  userId: string;
  day: string;
  tz: string;
  dayStart: Date;
  dayEnd: Date;
  /** Whether document names may be shown beside a visit or a dose. */
  documentsReadable: boolean;
}

export interface SectionPart {
  running: DayRunningItem[];
  events: DayEvent[];
}

/** A window wide enough to hold the day in any zone a row may carry. */
function zoneSafeWindow(frame: DayFrame): { gte: Date; lt: Date } {
  return {
    gte: new Date(frame.dayStart.getTime() - 14 * 3_600_000),
    lt: new Date(frame.dayEnd.getTime() + 14 * 3_600_000),
  };
}

/** Decrypt a free-text column for the response, or null with a warning. */
export function openText(
  buf: Uint8Array | null | undefined,
  what: string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `day ${what} decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Day n of a period that began on `since`, counting `since` as day 1. */
export function dayIndexOf(since: string, day: string): number | null {
  const n = daysBetweenDateKeys(since, day) + 1;
  return n >= 1 ? n : null;
}

/**
 * A running item with its day count. `since` is the record's own start date,
 * never the day the entry was made: a record that holds no start (a
 * medication filed without one) has no "day n" and no length to state, so it
 * says neither rather than counting from when it was typed in.
 */
function running(
  frame: DayFrame,
  item: Omit<DayRunningItem, "dayIndex" | "dayCount">,
): DayRunningItem {
  const { since, until } = item;
  if (since === null) return { ...item, dayIndex: null, dayCount: null };
  return {
    ...item,
    dayIndex: dayIndexOf(since, frame.day),
    // An end before the start (a hand-edited row) has no length to state.
    dayCount:
      until === null || until < since
        ? null
        : daysBetweenDateKeys(since, until) + 1,
  };
}

function event(
  item: Omit<DayEvent, "docs" | "meta" | "note"> &
    Partial<Pick<DayEvent, "docs" | "meta" | "note">>,
): DayEvent {
  return { meta: null, note: null, docs: [], ...item };
}

/** A `@db.Date` column value as its calendar key. */
function dateKeyOrNull(value: Date | null): string | null {
  return value ? dateOnlyKey(value) : null;
}

/* ─── medications ─────────────────────────────────────────────────────────── */

async function medicationsPart(frame: DayFrame): Promise<SectionPart> {
  const { userId, day } = frame;
  const dayDate = dayKeyAsUtcMidnight(day);
  const [meds, courses, pauses, intakes, doseChanges] = await Promise.all([
    prisma.medication.findMany({
      where: {
        userId,
        asNeeded: false,
        oneShot: false,
        // Without a start date, the day the medication was entered stands in.
        OR: [
          { startsOn: { lte: dayDate } },
          { startsOn: null, createdAt: { lt: frame.dayEnd } },
        ],
        AND: [{ OR: [{ endsOn: null }, { endsOn: { gte: dayDate } }] }],
      },
      select: {
        id: true,
        name: true,
        dose: true,
        active: true,
        startsOn: true,
        endsOn: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.medicationCourse.findMany({
      where: {
        userId,
        startsOn: { lte: dayDate },
        OR: [{ endsOn: null }, { endsOn: { gte: dayDate } }],
      },
      select: {
        id: true,
        medicationId: true,
        startsOn: true,
        endsOn: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medicationPauseEra.findMany({
      where: {
        userId,
        pausedAt: { lt: frame.dayEnd },
        OR: [{ resumedAt: null }, { resumedAt: { gte: frame.dayStart } }],
      },
      select: {
        id: true,
        medicationId: true,
        pausedAt: true,
        resumedAt: true,
        medication: { select: { name: true } },
      },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        deletedAt: null,
        skipped: false,
        takenAt: { gte: frame.dayStart, lt: frame.dayEnd },
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
      select: {
        id: true,
        medicationId: true,
        takenAt: true,
        doseTaken: true,
        medication: { select: { name: true, dose: true } },
      },
      orderBy: { takenAt: "asc" },
    }),
    prisma.medicationDoseChange.findMany({
      where: {
        medication: { userId },
        effectiveFrom: { gte: frame.dayStart, lt: frame.dayEnd },
      },
      select: {
        id: true,
        medicationId: true,
        effectiveFrom: true,
        doseValue: true,
        doseUnit: true,
        note: true,
        noteEncrypted: true,
        medication: { select: { name: true } },
      },
    }),
  ]);

  const out: SectionPart = { running: [], events: [] };
  for (const med of meds) {
    const since = dateKeyOrNull(med.startsOn);
    // Without a start date the entry's own date is the earliest the record
    // knows the medication; it bounds which days show it, but it is not a
    // start, so it never reaches the item.
    const shownFrom = since ?? userDayKey(med.createdAt, frame.tz);
    // An ended medication without an end date stopped when it was last
    // changed; that is the only date the record holds for it.
    const until =
      dateKeyOrNull(med.endsOn) ??
      (med.active ? null : userDayKey(med.updatedAt, frame.tz));
    if (shownFrom > day || (until !== null && until < day)) continue;
    const href = `/medications/${med.id}`;
    out.running.push(
      running(frame, {
        kind: "medication",
        section: "medications",
        id: med.id,
        title: med.name,
        sub: med.dose,
        since,
        until,
        href,
      }),
    );
    if (dateKeyOrNull(med.startsOn) === day) {
      out.events.push(
        event({
          at: null,
          kind: "medicationStart",
          section: "medications",
          id: med.id,
          title: med.name,
          meta: med.dose,
          href,
        }),
      );
    }
    if (dateKeyOrNull(med.endsOn) === day) {
      out.events.push(
        event({
          at: null,
          kind: "medicationEnd",
          section: "medications",
          id: med.id,
          title: med.name,
          meta: med.dose,
          href,
        }),
      );
    }
  }
  for (const course of courses) {
    const since = dateOnlyKey(course.startsOn);
    const until = dateKeyOrNull(course.endsOn);
    const href = `/medications/${course.medicationId}`;
    out.running.push(
      running(frame, {
        kind: "medicationCourse",
        section: "medications",
        id: course.id,
        title: course.medication.name,
        sub: null,
        since,
        until,
        href,
      }),
    );
    if (since === day) {
      out.events.push(
        event({
          at: null,
          kind: "courseStart",
          section: "medications",
          id: course.id,
          title: course.medication.name,
          href,
        }),
      );
    }
    if (until === day) {
      out.events.push(
        event({
          at: null,
          kind: "courseEnd",
          section: "medications",
          id: course.id,
          title: course.medication.name,
          href,
        }),
      );
    }
  }
  for (const pause of pauses) {
    const since = userDayKey(pause.pausedAt, frame.tz);
    const until = pause.resumedAt
      ? userDayKey(pause.resumedAt, frame.tz)
      : null;
    const href = `/medications/${pause.medicationId}`;
    out.running.push(
      running(frame, {
        kind: "medicationPause",
        section: "medications",
        id: pause.id,
        title: pause.medication.name,
        sub: null,
        since,
        until,
        href,
      }),
    );
    if (pause.pausedAt >= frame.dayStart) {
      out.events.push(
        event({
          at: pause.pausedAt.toISOString(),
          kind: "pauseStart",
          section: "medications",
          id: pause.id,
          title: pause.medication.name,
          href,
        }),
      );
    }
    if (
      pause.resumedAt &&
      pause.resumedAt >= frame.dayStart &&
      pause.resumedAt < frame.dayEnd
    ) {
      out.events.push(
        event({
          at: pause.resumedAt.toISOString(),
          kind: "pauseEnd",
          section: "medications",
          id: pause.id,
          title: pause.medication.name,
          href,
        }),
      );
    }
  }
  for (const intake of intakes) {
    out.events.push(
      event({
        at: intake.takenAt ? intake.takenAt.toISOString() : null,
        kind: "intake",
        section: "medications",
        id: intake.id,
        title: intake.medication.name,
        meta: intake.doseTaken ?? intake.medication.dose,
        href: `/medications/${intake.medicationId}/history`,
      }),
    );
  }
  for (const change of doseChanges) {
    let note: string | null = null;
    if (change.noteEncrypted && change.noteEncrypted.byteLength > 0) {
      note = openText(change.noteEncrypted, "dose change note");
    } else {
      note = change.note;
    }
    out.events.push(
      event({
        at: change.effectiveFrom.toISOString(),
        kind: "doseChange",
        section: "medications",
        id: change.id,
        title: change.medication.name,
        meta: `${change.doseValue} ${change.doseUnit}`,
        note,
        href: `/medications/${change.medicationId}/history`,
      }),
    );
  }
  return out;
}

/* ─── illness and symptoms ────────────────────────────────────────────────── */

async function illnessPart(frame: DayFrame): Promise<SectionPart> {
  const { userId, day } = frame;
  const [episodes, dayLogs] = await Promise.all([
    prisma.illnessEpisode.findMany({
      where: {
        userId,
        deletedAt: null,
        onsetAt: { lt: frame.dayEnd },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: frame.dayStart } }],
      },
      select: {
        id: true,
        label: true,
        lifecycle: true,
        onsetAt: true,
        resolvedAt: true,
      },
      orderBy: { onsetAt: "asc" },
    }),
    prisma.illnessDayLog.findMany({
      where: { userId, date: day, deletedAt: null },
      select: {
        id: true,
        episodeId: true,
        functionalImpact: true,
        noteEncrypted: true,
        createdAt: true,
        episode: { select: { label: true } },
      },
    }),
  ]);
  const out: SectionPart = { running: [], events: [] };
  for (const episode of episodes) {
    const href = `/illness/${episode.id}`;
    out.running.push(
      running(frame, {
        kind: "illness",
        section: "illness",
        id: episode.id,
        title: episode.label,
        sub: null,
        since: userDayKey(episode.onsetAt, frame.tz),
        until: episode.resolvedAt
          ? userDayKey(episode.resolvedAt, frame.tz)
          : null,
        href,
      }),
    );
    if (episode.onsetAt >= frame.dayStart) {
      out.events.push(
        event({
          at: episode.onsetAt.toISOString(),
          kind: "illnessOnset",
          section: "illness",
          id: episode.id,
          title: episode.label,
          href,
        }),
      );
    }
    if (episode.resolvedAt && episode.resolvedAt < frame.dayEnd) {
      out.events.push(
        event({
          at: episode.resolvedAt.toISOString(),
          kind: "illnessResolved",
          section: "illness",
          id: episode.id,
          title: episode.label,
          href,
        }),
      );
    }
  }
  for (const log of dayLogs) {
    out.events.push(
      event({
        at: null,
        kind: "illnessDayLog",
        section: "illness",
        id: log.id,
        title: log.episode.label,
        meta:
          log.functionalImpact === null ? null : String(log.functionalImpact),
        note: openText(log.noteEncrypted, "illness day log note"),
        href: `/illness/${log.episodeId}`,
      }),
    );
  }
  return out;
}

async function symptomsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.symptomEvent.findMany({
    where: {
      userId: frame.userId,
      occurredAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: {
      id: true,
      occurredAt: true,
      intensity: true,
      noteEncrypted: true,
      episodeId: true,
      definition: { select: { labelEncrypted: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.occurredAt.toISOString(),
        kind: "symptom",
        section: "symptoms",
        id: row.id,
        title: openText(row.definition.labelEncrypted, "symptom label") ?? "",
        meta: String(row.intensity),
        note: openText(row.noteEncrypted, "symptom note"),
        href: row.episodeId ? `/illness/${row.episodeId}` : "/illness",
      }),
    ),
  };
}

/* ─── profile: allergies, visits, vaccinations ───────────────────────────── */

async function allergiesPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.allergy.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      onsetAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: { id: true, substance: true, onsetAt: true, severity: true },
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.onsetAt ? row.onsetAt.toISOString() : null,
        kind: "allergyOnset",
        section: "allergies",
        id: row.id,
        title: row.substance,
        meta: row.severity,
        href: "/profile",
      }),
    ),
  };
}

async function visitsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.encounter.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      status: { in: ["DONE", "PLANNED"] },
      occurredAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: {
      id: true,
      occurredAt: true,
      kind: true,
      status: true,
      reasonEncrypted: true,
      outcomeEncrypted: true,
      practitioner: { select: { name: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  const docs = await documentsFor(
    frame,
    "encounter",
    rows.map((r) => r.id),
  );
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.occurredAt.toISOString(),
        kind: row.kind === "PROCEDURE" ? "procedure" : "visit",
        section: "visits",
        id: row.id,
        title:
          openText(row.reasonEncrypted, "visit reason") ??
          row.practitioner?.name ??
          "",
        meta: row.status === "PLANNED" ? "PLANNED" : row.kind,
        note: openText(row.outcomeEncrypted, "visit outcome"),
        docs: docs.get(row.id) ?? [],
        href: `/checkups?visit=${row.id}`,
      }),
    ),
  };
}

async function vaccinationsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      occurredAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: {
      id: true,
      occurredAt: true,
      vaccineName: true,
      antigenSlug: true,
      doseNumber: true,
      noteEncrypted: true,
      customVaccine: { select: { name: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  const docs = await documentsFor(
    frame,
    "vaccination",
    rows.map((r) => r.id),
  );
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.occurredAt.toISOString(),
        kind: "vaccination",
        section: "vaccinations",
        id: row.id,
        title:
          row.vaccineName ?? row.customVaccine?.name ?? row.antigenSlug ?? "",
        meta: row.doseNumber === null ? null : String(row.doseNumber),
        note: openText(row.noteEncrypted, "vaccination note"),
        docs: docs.get(row.id) ?? [],
        href: `/vaccinations?dose=${row.id}`,
      }),
    ),
  };
}

/* ─── labs, check-ups, documents ──────────────────────────────────────────── */

async function labsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.labResult.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      takenAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: {
      id: true,
      analyte: true,
      value: true,
      valueText: true,
      unit: true,
      takenAt: true,
      biomarkerId: true,
      noteEncrypted: true,
    },
    orderBy: [{ takenAt: "asc" }, { analyte: "asc" }],
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.takenAt.toISOString(),
        kind: "labResult",
        section: "labs",
        id: row.id,
        title: row.analyte,
        meta:
          row.value !== null
            ? `${row.value} ${row.unit}`.trim()
            : (row.valueText ?? null),
        note: openText(row.noteEncrypted, "lab note"),
        href: row.biomarkerId ? `/labs/${row.biomarkerId}` : "/labs",
      }),
    ),
  };
}

async function checkupsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.measurementReminderEvent.findMany({
    where: {
      userId: frame.userId,
      kind: "SATISFIED",
      occurredAt: { gte: frame.dayStart, lt: frame.dayEnd },
      reminder: { deletedAt: null, origin: "VORSORGE" },
    },
    select: {
      id: true,
      occurredAt: true,
      reminder: { select: { id: true, label: true } },
    },
    orderBy: { occurredAt: "asc" },
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.occurredAt.toISOString(),
        kind: "checkup",
        section: "checkups",
        id: row.id,
        title: row.reminder.label,
        href: "/checkups",
      }),
    ),
  };
}

async function documentsPart(frame: DayFrame): Promise<SectionPart> {
  // A document's date is a calendar date stored at noon UTC (older rows at
  // UTC midnight): both anchors fall inside this UTC calendar day, and the
  // date key decides. The stated report date wins over the filing date.
  const start = dayKeyAsUtcMidnight(frame.day);
  const end = dayKeyAsUtcMidnight(shiftDateKey(frame.day, 1));
  const rows = await prisma.inboundDocument.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      OR: [
        { reportDate: { gte: start, lt: end } },
        { reportDate: null, documentDate: { gte: start, lt: end } },
      ],
    },
    select: {
      id: true,
      kind: true,
      title: true,
      filename: true,
      reportDate: true,
      documentDate: true,
    },
  });
  return {
    running: [],
    events: rows
      .filter(
        (row) =>
          dateKeyOrNull(row.reportDate ?? row.documentDate) === frame.day,
      )
      .map((row) =>
        event({
          at: null,
          kind: "document",
          section: "documents",
          id: row.id,
          title: row.title ?? row.filename ?? "",
          meta: row.kind,
          href: `/documents?doc=${row.id}`,
        }),
      ),
  };
}

/** Documents filed against visits or doses, when the grant reaches the vault. */
async function documentsFor(
  frame: DayFrame,
  sourceKind: "encounter" | "vaccination",
  sourceIds: string[],
): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>();
  // The filename of a scanned page is itself the sensitive part, so a grant
  // that does not reach the vault gets no names here.
  if (!frame.documentsReadable || sourceIds.length === 0) return out;
  const map = await listTargetsBySource(prisma, {
    userId: frame.userId,
    sourceKind,
    sourceIds,
    targetKind: "document",
  });
  for (const [id, targets] of map) {
    out.set(
      id,
      targets.map((t) => ({ id: t.id, name: t.label })),
    );
  }
  return out;
}

/* ─── mind: mood and screeners ────────────────────────────────────────────── */

async function moodPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.moodEntry.findMany({
    where: { userId: frame.userId, date: frame.day, deletedAt: null },
    select: {
      id: true,
      mood: true,
      score: true,
      moodLoggedAt: true,
      note: true,
      noteEncrypted: true,
    },
    orderBy: { moodLoggedAt: "asc" },
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.moodLoggedAt.toISOString(),
        kind: "mood",
        section: "mood",
        id: row.id,
        title: row.mood,
        meta: String(row.score),
        note:
          row.noteEncrypted && row.noteEncrypted.byteLength > 0
            ? openText(row.noteEncrypted, "mood note")
            : row.note,
        href: `/mood?from=${frame.day}&to=${frame.day}`,
      }),
    ),
  };
}

async function assessmentsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.mentalHealthAssessment.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      takenAt: zoneSafeWindow(frame),
    },
    select: {
      id: true,
      instrument: true,
      totalScore: true,
      severityBand: true,
      takenAt: true,
      tz: true,
    },
    orderBy: { takenAt: "asc" },
  });
  return {
    running: [],
    events: rows
      // A screener carries the zone it was taken in; its day is cut there.
      .filter(
        (row) =>
          userDayKey(row.takenAt, row.tz ? effectiveMoodTz(row) : frame.tz) ===
          frame.day,
      )
      .map((row) =>
        event({
          at: row.takenAt.toISOString(),
          kind: "assessment",
          section: "assessments",
          id: row.id,
          title: row.instrument,
          meta: `${row.totalScore} ${row.severityBand}`,
          href: "/mental-wellbeing",
        }),
      ),
  };
}

/* ─── workouts, cycle ─────────────────────────────────────────────────────── */

async function workoutsPart(frame: DayFrame): Promise<SectionPart> {
  const rows = await prisma.workout.findMany({
    where: {
      userId: frame.userId,
      startedAt: { gte: frame.dayStart, lt: frame.dayEnd },
    },
    select: { id: true, sportType: true, startedAt: true, durationSec: true },
    orderBy: { startedAt: "asc" },
  });
  return {
    running: [],
    events: rows.map((row) =>
      event({
        at: row.startedAt.toISOString(),
        kind: "workout",
        section: "workouts",
        id: row.id,
        title: row.sportType,
        meta: `${Math.round(row.durationSec / 60)} min`,
        href: `/insights/workouts/${row.id}`,
      }),
    ),
  };
}

async function cyclePart(frame: DayFrame): Promise<SectionPart> {
  const [cycles, logs] = await Promise.all([
    prisma.menstrualCycle.findMany({
      where: {
        userId: frame.userId,
        deletedAt: null,
        isPredicted: false,
        absorbedIntoId: null,
        startDate: { lte: frame.day },
        OR: [{ endDate: null }, { endDate: { gte: frame.day } }],
      },
      select: { id: true, startDate: true, endDate: true },
      orderBy: { startDate: "desc" },
      take: 1,
    }),
    prisma.cycleDayLog.findMany({
      where: { userId: frame.userId, date: frame.day, deletedAt: null },
      select: { id: true, flow: true },
    }),
  ]);
  return {
    running: cycles.map((cycle) =>
      running(frame, {
        kind: "cyclePhase",
        section: "cycle",
        id: cycle.id,
        title: "cycle",
        sub: null,
        since: cycle.startDate,
        until: cycle.endDate,
        href: "/cycle",
      }),
    ),
    events: logs.map((log) =>
      event({
        at: null,
        kind: "cycleDayLog",
        section: "cycle",
        id: log.id,
        title: "cycle",
        meta: log.flow,
        href: "/cycle",
      }),
    ),
  };
}

/* ─── environment, life events ────────────────────────────────────────────── */

async function environmentPart(frame: DayFrame): Promise<SectionPart> {
  // The travel period only; the day's weather row is a value the client
  // reads from `/api/environment`. No place name leaves here: the label is
  // sealed with the coordinates, and a trip is "away" without it.
  const trips = await prisma.environmentTravelLocation.findMany({
    where: {
      userId: frame.userId,
      startDate: { lte: frame.day },
      endDate: { gte: frame.day },
    },
    select: { id: true, startDate: true, endDate: true },
  });
  return {
    running: trips.map((trip) =>
      running(frame, {
        kind: "travel",
        section: "environment",
        id: trip.id,
        title: "travel",
        sub: null,
        since: trip.startDate,
        until: trip.endDate,
        href: null,
      }),
    ),
    events: [],
  };
}

async function lifeEventsPart(frame: DayFrame): Promise<SectionPart> {
  // Day-precise events on this day, and periods (any precision) spanning it.
  const rows = await prisma.lifeEvent.findMany({
    where: {
      userId: frame.userId,
      deletedAt: null,
      startDate: { lte: frame.day },
      OR: [
        { startDate: frame.day, precision: "DAY" },
        // A coarse end reaches to the end of its month or year, so the row is
        // a candidate from the first of the day's year; the exact rule runs
        // below.
        { endDate: { gte: `${frame.day.slice(0, 4)}-01-01` } },
      ],
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      precision: true,
      category: true,
      titleEncrypted: true,
      noteEncrypted: true,
    },
    orderBy: { startDate: "asc" },
  });
  const out: SectionPart = { running: [], events: [] };
  for (const row of rows) {
    const title = openText(row.titleEncrypted, "life event title") ?? "";
    const href = `/timeline?day=${frame.day}`;
    const end =
      row.endDate === null ? null : lastDayCovered(row.endDate, row.precision);
    if (end !== null && end >= frame.day) {
      out.running.push(
        running(frame, {
          kind: "lifeEvent",
          section: "lifeEvents",
          id: row.id,
          title,
          sub: row.category,
          since: row.startDate,
          until: end,
          href,
        }),
      );
    }
    if (row.precision === "DAY" && row.startDate === frame.day) {
      out.events.push(
        event({
          at: null,
          kind: "lifeEvent",
          section: "lifeEvents",
          id: row.id,
          title,
          meta: row.category,
          note: openText(row.noteEncrypted, "life event note"),
          href,
        }),
      );
    }
  }
  return out;
}

/** The record-side reader of each section; values and sleep are elsewhere. */
export const RECORD_SECTION_READERS: Readonly<
  Partial<Record<DaySectionKey, (frame: DayFrame) => Promise<SectionPart>>>
> = Object.freeze({
  medications: medicationsPart,
  illness: illnessPart,
  symptoms: symptomsPart,
  allergies: allergiesPart,
  labs: labsPart,
  visits: visitsPart,
  vaccinations: vaccinationsPart,
  checkups: checkupsPart,
  documents: documentsPart,
  mood: moodPart,
  assessments: assessmentsPart,
  workouts: workoutsPart,
  cycle: cyclePart,
  environment: environmentPart,
  lifeEvents: lifeEventsPart,
});
