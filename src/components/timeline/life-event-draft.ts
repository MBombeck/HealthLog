/**
 * The life-event form's state and its checks (v1.42, #613).
 *
 * Plain functions, no validator library: the timeline chunk stays light, and
 * the rules are the server's own (`lifeEventCreateSchema` in
 * `src/lib/day/wire-schemas.ts`), restated so the form can say what is wrong
 * before anything is sent. The server checks again; this only spares a
 * round trip.
 *
 * A date is held as a calendar key at the chosen precision: at MONTH it is
 * the first of the month, at YEAR the first of January. Switching precision
 * realigns both ends, so "September 2023" has exactly one spelling, the one
 * the server accepts.
 */
import type {
  LifeEventCategory,
  LifeEventCreateInput,
  LifeEventDTO,
  LifeEventPrecision,
  LifeEventUpdateInput,
} from "@/lib/day/contract";
import { LIFE_EVENT_NOTE_MAX, LIFE_EVENT_TITLE_MAX } from "@/lib/day/contract";
import { isCalendarDateKey } from "@/lib/tz/date-only";

export interface LifeEventDraft {
  title: string;
  category: LifeEventCategory | null;
  precision: LifeEventPrecision;
  start: string;
  /** Null when the event is a moment rather than a period. */
  end: string | null;
  note: string;
}

/** What a draft can be refused for, each worded under `lifeEvents.errors`. */
export type LifeEventDraftError =
  | "titleRequired"
  | "titleTooLong"
  | "categoryRequired"
  | "dateRequired"
  | "endBeforeStart"
  | "noteTooLong";

export type LifeEventDraftErrors = Partial<
  Record<"title" | "category" | "start" | "end" | "note", LifeEventDraftError>
>;

/** Snap a date to the first day of its month or year. */
export function alignToPrecision(
  key: string,
  precision: LifeEventPrecision,
): string {
  if (!isCalendarDateKey(key)) return key;
  if (precision === "MONTH") return `${key.slice(0, 7)}-01`;
  if (precision === "YEAR") return `${key.slice(0, 4)}-01-01`;
  return key;
}

export function emptyDraft(defaultDate: string): LifeEventDraft {
  return {
    title: "",
    category: null,
    precision: "DAY",
    start: defaultDate,
    end: null,
    note: "",
  };
}

export function draftFromEvent(event: LifeEventDTO): LifeEventDraft {
  return {
    title: event.title ?? "",
    category: event.category,
    precision: event.precision,
    start: event.startDate,
    end: event.endDate,
    note: event.note ?? "",
  };
}

/** The draft at a new precision, both ends realigned. */
export function withPrecision(
  draft: LifeEventDraft,
  precision: LifeEventPrecision,
): LifeEventDraft {
  return {
    ...draft,
    precision,
    start: alignToPrecision(draft.start, precision),
    end: draft.end === null ? null : alignToPrecision(draft.end, precision),
  };
}

/**
 * The message keys (under `lifeEvents.errors`) for what keeps the draft from
 * saving. An empty object means it can be sent.
 */
export function validateDraft(draft: LifeEventDraft): LifeEventDraftErrors {
  const errors: LifeEventDraftErrors = {};
  const title = draft.title.trim();
  if (title.length === 0) errors.title = "titleRequired";
  else if (title.length > LIFE_EVENT_TITLE_MAX) errors.title = "titleTooLong";
  if (draft.category === null) errors.category = "categoryRequired";
  if (!isCalendarDateKey(draft.start)) errors.start = "dateRequired";
  if (draft.end !== null) {
    if (!isCalendarDateKey(draft.end)) errors.end = "dateRequired";
    else if (isCalendarDateKey(draft.start) && draft.end < draft.start) {
      errors.end = "endBeforeStart";
    }
  }
  if (draft.note.trim().length > LIFE_EVENT_NOTE_MAX)
    errors.note = "noteTooLong";
  return errors;
}

/** The POST body. Call only with a draft `validateDraft` passed. */
export function createBody(draft: LifeEventDraft): LifeEventCreateInput {
  const note = draft.note.trim();
  return {
    category: draft.category as LifeEventCategory,
    precision: draft.precision,
    startDate: alignToPrecision(draft.start, draft.precision),
    endDate:
      draft.end === null ? null : alignToPrecision(draft.end, draft.precision),
    title: draft.title.trim(),
    note: note.length > 0 ? note : null,
  };
}

/**
 * The PATCH body: only what changed. Precision and both dates travel
 * together whenever one of them moved, because the server re-checks their
 * alignment against each other.
 */
export function updateBody(
  before: LifeEventDTO,
  draft: LifeEventDraft,
): LifeEventUpdateInput {
  const next = createBody(draft);
  const body: LifeEventUpdateInput = {};
  if (next.title !== (before.title ?? "")) body.title = next.title;
  if (next.category !== before.category) body.category = next.category;
  if ((next.note ?? null) !== (before.note ?? null))
    body.note = next.note ?? null;
  if (
    next.precision !== before.precision ||
    next.startDate !== before.startDate ||
    (next.endDate ?? null) !== before.endDate
  ) {
    body.precision = next.precision;
    body.startDate = next.startDate;
    body.endDate = next.endDate ?? null;
  }
  return body;
}
