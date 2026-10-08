/**
 * The one way a day leaves for a model (v1.42, #613).
 *
 * The Coach and the MCP endpoint read a day through `get_day`, and both go
 * through this projection. It does three things and nothing else:
 *
 *   - drops every section in {@link MODEL_EXCLUDED_DAY_SECTIONS} (life events
 *     in v1.42), wherever it appears: running items, events and the section
 *     list. The person's life events never reach a model, not even as a
 *     count;
 *   - drops the person's notes, the documents filed against an entry, the
 *     name of a dated document (its kind stands in: a file name is whatever
 *     the person or a scanner called it), and a visit's reason and the
 *     practitioner's name (the visit's kind stands in). A model reads what
 *     the day held, not what the person wrote about it; the notes have their
 *     own, separately fenced reads where a feature needs them;
 *   - names a switched-off module's section as `module_disabled`, so a model
 *     says "that module is off" instead of "nothing happened";
 *   - leaves out what the caller excludes (`exclude`): the Coach passes the
 *     person's Coach exclusions as sections and measurement types, so a
 *     metric left out of every other Coach read is left out of the day too,
 *     without a word about it.
 *
 * The remaining titles (a medication, an illness label, a symptom) pass
 * through `text`, which fences them as the person's own text.
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import {
  MODEL_EXCLUDED_DAY_SECTIONS,
  type DayResponse,
  type DaySectionKey,
} from "@/lib/day/contract";

const EXCLUDED: ReadonlySet<DaySectionKey> = new Set<DaySectionKey>(
  MODEL_EXCLUDED_DAY_SECTIONS,
);

export interface ModelDayRunning {
  kind: DayResponse["running"][number]["kind"];
  section: DaySectionKey;
  title: string;
  sub: string | null;
  since: string;
  until: string | null;
  dayIndex: number | null;
  dayCount: number | null;
}

export interface ModelDayEvent {
  at: string | null;
  kind: DayResponse["events"][number]["kind"];
  section: DaySectionKey;
  title: string;
  meta: string | null;
}

export interface ModelDay {
  date: string;
  counts: { values: number; entries: number };
  running: ModelDayRunning[];
  values: Array<{
    type: string;
    value: number;
    unit: string;
    at: string;
    band: { lo: number; hi: number; n: number } | null;
  }>;
  events: ModelDayEvent[];
  notable: DayResponse["notable"];
  /** Sections the reader does not get, and why. Never a model-excluded one. */
  unavailable: Array<{
    section: DaySectionKey;
    reason: "module_disabled" | "not_shared";
  }>;
}

/** What one caller leaves out of the model's day, on top of the fixed rules. */
export interface ModelDayExclusions {
  sections: ReadonlySet<DaySectionKey>;
  types: ReadonlySet<string>;
}

const NO_EXCLUSIONS: ModelDayExclusions = {
  sections: new Set(),
  types: new Set(),
};

/**
 * The title an event reaches a model with. A document's own name and a
 * visit's reason or practitioner are free text the person (or a scanner)
 * wrote; the closed code beside them says what the entry was.
 */
function modelEventTitle(
  item: DayResponse["events"][number],
  text: (value: string) => string,
): string {
  switch (item.kind) {
    case "document":
      return item.meta ?? "document";
    case "visit":
    case "procedure":
      return item.kind;
    default:
      return text(item.title);
  }
}

/** Whether a section may reach a model at all. */
export function isModelVisibleSection(section: DaySectionKey): boolean {
  return !EXCLUDED.has(section);
}

export function projectDayForModel(
  day: DayResponse,
  moduleOff: readonly DaySectionKey[],
  text: (value: string) => string = (value) => value,
  exclude: ModelDayExclusions = NO_EXCLUSIONS,
): ModelDay {
  const visible = (section: DaySectionKey) =>
    isModelVisibleSection(section) && !exclude.sections.has(section);
  const running = day.running
    .filter((item) => visible(item.section))
    .map((item) => ({
      kind: item.kind,
      section: item.section,
      title: text(item.title),
      sub: item.sub === null ? null : text(item.sub),
      since: item.since,
      until: item.until,
      dayIndex: item.dayIndex,
      dayCount: item.dayCount,
    }));
  const events = day.events
    .filter((item) => visible(item.section))
    .map((item) => ({
      at: item.at,
      kind: item.kind,
      section: item.section,
      title: modelEventTitle(item, text),
      meta: item.meta,
    }));
  const unavailable: ModelDay["unavailable"] = [];
  for (const section of moduleOff) {
    if (visible(section)) {
      unavailable.push({ section, reason: "module_disabled" });
    }
  }
  for (const key of Object.keys(day.sections) as DaySectionKey[]) {
    if (visible(key)) {
      unavailable.push({ section: key, reason: "not_shared" });
    }
  }
  const values = day.values.filter((v) => !exclude.types.has(v.type));
  return {
    date: day.date,
    counts: { values: values.length, entries: events.length },
    running,
    values: values.map((v) => ({
      type: v.type as MeasurementType,
      value: v.value,
      unit: v.unit,
      at: v.at,
      band: v.band,
    })),
    events,
    notable: day.notable.filter(
      (n) => n.type === null || !exclude.types.has(n.type),
    ),
    unavailable,
  };
}
