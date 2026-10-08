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
 *   - drops the person's notes and the names of filed documents. A model
 *     reads what the day held, not what the person wrote about it; the notes
 *     have their own, separately fenced reads where a feature needs them;
 *   - names a switched-off module's section as `module_disabled`, so a model
 *     says "that module is off" instead of "nothing happened".
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

/** Whether a section may reach a model at all. */
export function isModelVisibleSection(section: DaySectionKey): boolean {
  return !EXCLUDED.has(section);
}

export function projectDayForModel(
  day: DayResponse,
  moduleOff: readonly DaySectionKey[],
  text: (value: string) => string = (value) => value,
): ModelDay {
  const running = day.running
    .filter((item) => isModelVisibleSection(item.section))
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
    .filter((item) => isModelVisibleSection(item.section))
    .map((item) => ({
      at: item.at,
      kind: item.kind,
      section: item.section,
      title: text(item.title),
      meta: item.meta,
    }));
  const unavailable: ModelDay["unavailable"] = [];
  for (const section of moduleOff) {
    if (isModelVisibleSection(section)) {
      unavailable.push({ section, reason: "module_disabled" });
    }
  }
  for (const key of Object.keys(day.sections) as DaySectionKey[]) {
    if (isModelVisibleSection(key)) {
      unavailable.push({ section: key, reason: "not_shared" });
    }
  }
  return {
    date: day.date,
    counts: { values: day.values.length, entries: events.length },
    running,
    values: day.values.map((v) => ({
      type: v.type as MeasurementType,
      value: v.value,
      unit: v.unit,
      at: v.at,
      band: v.band,
    })),
    events,
    notable: day.notable,
    unavailable,
  };
}
