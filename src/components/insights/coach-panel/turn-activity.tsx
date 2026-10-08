"use client";

/**
 * v1.41.1 — the thinking row of a Coach turn: one quiet line at the top of
 * the answer, and the steps behind it.
 *
 * The row is a brain, the status text and a chevron, in the answer's own
 * text size and the muted tone. While the turn runs the text says what the
 * Coach is doing right now ("Fetching blood pressure, last 90 days…", or
 * "Thinking…" before the first frame), with a shimmer passing through it and
 * the trailing dots fading in turn; there is no clock. When the answer is
 * done the row settles into "Thought process · N steps", and a turn that
 * ends on a question to the person says "Answer needed" instead. The chevron
 * only shows when there is something to open.
 *
 * Nothing opens by itself. The row starts closed in every state, only a tap
 * opens it, and a row opened while the turn ran closes again when it ends:
 * the answer is what the person came for. Open, it lists the steps one under
 * the other, each with a small icon on a thin line that runs to the next
 * one, a reasoning round with its summary underneath; then the method line
 * and the tables the answer used without pointing at them.
 *
 * Labels are catalog text the server rendered; titles and texts are screened
 * model text the owner alone receives. A persisted message carries only the
 * metadata, so its titles and texts are read from `…/trail` the first time
 * the person opens the row. A message saved before v1.41 has no activity
 * and falls back to its step list (`metricSource.steps`), and one saved
 * before steps existed to the areas it drew on.
 *
 * Screen readers hear the status through a polite live region, throttled to
 * one announcement per `ANNOUNCE_THROTTLE_MS` (the latest wins), and the
 * settled line once when the turn ends. A reloaded conversation announces
 * nothing.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Bookmark,
  Brain,
  ChartLine,
  ChartScatter,
  CalendarDays,
  CloudSun,
  ChevronDown,
  CircleStop,
  Database,
  FileSearch,
  Lightbulb,
  ListTodo,
  MessageCircleQuestion,
  PenLine,
  Sigma,
  Table2,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { WaitingText } from "@/components/ui/waiting-text";
import {
  COACH_STEP_REASON_KEYS,
  COACH_STEP_UI_KEYS,
  coachDomainLabelKey,
  coachGranularityLabelKey,
  coachPeriodLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import {
  COACH_ACTIVITY_KEYS,
  activityThoughtProcessKey,
} from "@/lib/ai/coach/activity/contract";
import type {
  CoachActivity,
  CoachMethod,
  CoachProvenanceMetric,
  CoachStep,
  CoachTrail,
} from "@/lib/ai/coach/types";

import { COACH_FOCUS_RING } from "./focus-ring";
import { CoachMethodLine } from "./method-line";

/** The shortest gap between two screen-reader announcements. */
export const ANNOUNCE_THROTTLE_MS = 1500;

/** A trailing "…" or "...", which a finished entry no longer carries. */
const TRAILING_ELLIPSIS = /(?:…|\.\.\.)\s*$/u;

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;
type TranslateCount = (
  baseKey: string,
  count: number,
  params?: Record<string, string | number>,
) => string;

/** `t(key)`, or `fallback` when the bundle does not carry the key. */
function tOr(
  t: Translate,
  key: string,
  fallback: string,
  params?: Record<string, string | number>,
) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

// ── Steps (messages saved before v1.41, and the fetch rows) ────────────────

/**
 * The step's label in the reader's language: the catalog key rendered with
 * the domain and window names, or the server's label when the key is not
 * in the bundle.
 */
export function stepLabel(step: CoachStep, t: Translate): string {
  return tOr(t, step.labelKey, step.label, {
    ...(step.domain ? { domain: t(coachDomainLabelKey(step.domain)) } : {}),
    ...(step.window ? { window: t(coachWindowLabelKey(step.window)) } : {}),
  });
}

/**
 * One row's text: the domain as the title, then the window, period,
 * granularity, and either how much was read or why nothing was.
 */
export function describeStep(
  step: CoachStep,
  t: Translate,
  tCount: TranslateCount,
): { title: string; meta: string[] } {
  const title = step.domain
    ? t(coachDomainLabelKey(step.domain))
    : stepLabel(step, t);
  const meta: string[] = [];
  if (step.window) meta.push(t(coachWindowLabelKey(step.window)));
  if (step.period && step.period !== "current") {
    meta.push(t(coachPeriodLabelKey(step.period)));
  }
  if (step.granularity)
    meta.push(t(coachGranularityLabelKey(step.granularity)));
  if (step.status === "done" && step.count !== undefined) {
    const base =
      step.tool === "snapshot"
        ? "coach.step.metrics"
        : step.tool === "get_labs"
          ? "coach.step.rows"
          : "coach.step.readings";
    meta.push(tCount(base, step.count));
  } else if (step.status !== "running" && step.reason) {
    meta.push(t(COACH_STEP_REASON_KEYS[step.reason]));
  }
  return { title, meta };
}

/**
 * The step a legacy running line names: the latest one still running, else
 * the latest one overall (between two rounds nothing is running).
 */
export function currentStep(steps: CoachStep[]): CoachStep | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return steps[i];
  }
  return steps.at(-1) ?? null;
}

/**
 * The areas an older message drew on, in the order its provenance lists
 * them, by their display names. A token without a name in the bundle is
 * dropped, and so is `general`, which names no area of the record.
 */
export function legacyAreaLabels(
  areas: readonly CoachProvenanceMetric[] | undefined,
  t: Translate,
): string[] {
  const out: string[] = [];
  for (const area of areas ?? []) {
    if (area === "general") continue;
    const key = `insights.coach.metric.${area}`;
    const label = t(key);
    if (label === key || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

// ── Activity ───────────────────────────────────────────────────────────────

/**
 * The entry the running line names: the latest one still running, else the
 * latest one overall. Null when the turn has sent no activity yet.
 */
export function currentActivity(
  activity: readonly CoachActivity[],
): CoachActivity | null {
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    if (activity[i].status === "running") return activity[i];
  }
  return activity.at(-1) ?? null;
}

/**
 * What an entry is called: a screened reasoning title for a thinking round
 * once one has arrived, else the server's catalog label. A finished entry
 * no longer trails off: "Writing the answer", not "Writing the answer…".
 */
export function activityLineLabel(entry: CoachActivity): string {
  if (
    (entry.phase === "thinking" || entry.phase === "checkpoint") &&
    entry.title
  ) {
    return entry.title;
  }
  return entry.status === "running"
    ? entry.label
    : entry.label.replace(TRAILING_ELLIPSIS, "");
}

/**
 * Whether the row stays open as the turn moves on: a row opened while the
 * turn ran closes when it ends. Nothing ever opens it but a tap.
 */
export function openAfter(args: {
  open: boolean;
  wasActive: boolean;
  active: boolean;
}): boolean {
  return args.wasActive && !args.active ? false : args.open;
}

/** The running row's text: whatever it names, still going ("…"). */
export function inProgressLabel(label: string): string {
  return `${label.replace(TRAILING_ELLIPSIS, "")}…`;
}

/**
 * The icon of a step: what kind of work it was. Reads of the record are a
 * database, a table read for the answer a table, connections a scatter, an
 * earlier chart reopened a chart, the record summary a search.
 */
export function stepIcon(
  phase: CoachActivity["phase"] | null,
  tool: CoachStep["tool"] | undefined,
): LucideIcon {
  switch (phase) {
    case "thinking":
    case "checkpoint":
      return Lightbulb;
    case "memory":
      return BookOpen;
    case "digest":
      return Sigma;
    case "remember":
      return Bookmark;
    case "plan":
      return ListTodo;
    case "asking":
      return MessageCircleQuestion;
    case "stop":
      return CircleStop;
    case "answer":
      return PenLine;
    default:
      break;
  }
  switch (tool) {
    case "snapshot":
      return FileSearch;
    case "show_result":
      return ChartLine;
    case "get_correlations":
      return ChartScatter;
    case "get_environment":
      return CloudSun;
    case "get_day":
      return CalendarDays;
    case "get_metric_table":
      return Table2;
    default:
      return Database;
  }
}

/**
 * The status region's text: the running line as it changes, throttled, and
 * the settled line once when the turn ends. Nothing is announced for a row
 * that was already settled when it mounted.
 */
function useLineAnnouncement(text: string, active: boolean): string {
  const [mountedActive] = useState(active);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const said = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    // A reloaded, settled row stays quiet.
    if (!mountedActive) return;
    if (!text || text === said.current) return;
    said.current = text;
    const wait = Math.max(
      0,
      lastAt.current + ANNOUNCE_THROTTLE_MS - Date.now(),
    );
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      setAnnouncement(text);
    }, wait);
  }, [text, mountedActive]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return announcement;
}

/** The owner-only titles and texts of a persisted message's trail. */
function useTrailText(args: {
  conversationId: string | null | undefined;
  messageId: string | null | undefined;
  enabled: boolean;
}): CoachTrail | null {
  const { conversationId, messageId, enabled } = args;
  const query = useQuery({
    queryKey: queryKeys.coachMessageTrail(
      conversationId ?? "",
      messageId ?? "",
    ),
    queryFn: async (): Promise<CoachTrail | null> => {
      const data = await apiGet<
        { trail?: CoachTrail | null } | CoachTrail | null
      >(
        `/api/insights/chat/${encodeURIComponent(conversationId ?? "")}/messages/${encodeURIComponent(messageId ?? "")}/trail`,
      );
      if (!data) return null;
      if ("entries" in data) return data;
      return data.trail ?? null;
    },
    enabled: enabled && !!conversationId && !!messageId,
    // The trail is the stored snapshot of a finished turn; it never changes.
    staleTime: Infinity,
    retry: false,
  });
  return query.data ?? null;
}

// ── The open list ──────────────────────────────────────────────────────────

/** How a step reads: the one going on now, a finished one, a failed one. */
type StepTone = "active" | "done" | "failed";

interface TrailItem {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Muted parts under the label, joined by a middle dot. */
  meta?: string[];
  /** A reasoning summary under the label. */
  text?: string;
  /** What the memory step recalled, one per line. */
  recalled?: string[];
  tone: StepTone;
  phase?: CoachActivity["phase"];
  status?: CoachActivity["status"];
}

function toneOf(status: CoachActivity["status"], active: boolean): StepTone {
  if (status === "failed") return "failed";
  return status === "running" && active ? "active" : "done";
}

/** The activity entries of a turn, as the rows of the open list. */
function activityItems(args: {
  activity: CoachActivity[];
  steps: CoachStep[];
  trail: CoachTrail | null;
  active: boolean;
  t: Translate;
  tCount: TranslateCount;
}): TrailItem[] {
  const { activity, steps, trail, active, t, tCount } = args;
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const textById = new Map(
    (trail?.entries ?? []).map((entry) => [entry.id, entry]),
  );
  return activity.map((entry) => {
    const stored = textById.get(entry.id);
    const merged: CoachActivity = {
      ...entry,
      title: entry.title ?? stored?.title,
      text: entry.text ?? stored?.text,
    };
    const step = entry.stepRef ? stepsById.get(entry.stepRef) : undefined;
    const base = {
      key: entry.id,
      icon: stepIcon(entry.phase, step?.tool),
      tone: toneOf(entry.status, active),
      phase: entry.phase,
      status: entry.status,
    };
    if (entry.phase === "fetch" && step) {
      const { title, meta } = describeStep(step, t, tCount);
      return { ...base, label: title, meta };
    }
    return {
      ...base,
      label: activityLineLabel(merged),
      text: merged.text,
      recalled:
        entry.phase === "memory" && trail?.recalled?.length
          ? trail.recalled
          : undefined,
    };
  });
}

/** A legacy message's steps, as the rows of the open list. */
function stepItems(
  steps: CoachStep[],
  active: boolean,
  t: Translate,
  tCount: TranslateCount,
): TrailItem[] {
  return steps.map((step) => {
    const { title, meta } = describeStep(step, t, tCount);
    return {
      key: step.id,
      icon: stepIcon(null, step.tool),
      label: title,
      meta,
      tone: toneOf(step.status, active),
      status: step.status,
    };
  });
}

const TONE_CLASS: Record<StepTone, string> = {
  active: "text-foreground",
  done: "text-muted-foreground",
  failed: "text-destructive",
};

function StepMeta({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? (
            <>
              <span aria-hidden="true"> · </span>
              {/* The comma is for a screen reader only. `select-none` keeps
                  it out of a copied row. */}
              <span className="sr-only select-none">, </span>
            </>
          ) : null}
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * The steps, one under the other: a small icon in the left column on a thin
 * line that runs down to the next step, the label beside it and anything it
 * has to say underneath.
 */
function TrailList({
  items,
  slot,
  itemSlot,
  label,
}: {
  items: TrailItem[];
  slot: string;
  itemSlot: string;
  label: string;
}) {
  return (
    <ol data-slot={slot} aria-label={label} className="flex flex-col">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const Icon = item.icon;
        return (
          <li
            key={item.key}
            data-slot={itemSlot}
            data-phase={item.phase}
            data-status={item.status}
            className="flex min-w-0 gap-2.5"
          >
            <div className="flex shrink-0 flex-col items-center">
              <span className="flex h-6 items-center">
                <Icon
                  aria-hidden="true"
                  className={cn("size-4", TONE_CLASS[item.tone])}
                />
              </span>
              {!last ? (
                <span
                  aria-hidden="true"
                  data-slot="coach-turn-step-connector"
                  className="bg-border w-px flex-1"
                />
              ) : null}
            </div>
            <div
              className={cn(
                "flex min-w-0 flex-col pt-0.5 leading-5",
                !last && "pb-3",
              )}
            >
              <span className={cn("min-w-0", TONE_CLASS[item.tone])}>
                {item.label}
              </span>
              {item.meta?.length ? (
                <span className="text-muted-foreground min-w-0">
                  <StepMeta parts={item.meta} />
                </span>
              ) : null}
              {item.text ? (
                <p
                  data-slot="coach-turn-step-detail"
                  className="text-muted-foreground whitespace-pre-wrap"
                >
                  {item.text}
                </p>
              ) : null}
              {item.recalled?.length ? (
                <ul
                  data-slot="coach-turn-step-detail"
                  className="text-muted-foreground flex flex-col"
                >
                  {item.recalled.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── The row ────────────────────────────────────────────────────────────────

export interface CoachTurnActivityProps {
  /** The live trail, or `metricSource.activity` of a persisted message. */
  activity: CoachActivity[];
  /** The steps the fetch entries point at; a legacy message's whole list. */
  steps: CoachStep[];
  /** True while the turn is still running. */
  active: boolean;
  /**
   * True when the settled turn asked the person something and waits for
   * the choice: the row says so instead of summing up.
   */
  awaitingAnswer?: boolean;
  /**
   * The provenance metrics, for a message saved before steps existed. Read
   * only when there is neither activity nor steps.
   */
  areas?: readonly CoachProvenanceMetric[];
  /** How the answer was worked out; shown at the end of the open list. */
  method?: CoachMethod | null;
  /**
   * The tables the answer read without pointing at them, shown last in the
   * open list. Pass it only when there is something to show.
   */
  dataUsed?: ReactNode;
  /** The persisted message, for reading its stored titles and texts. */
  conversationId?: string | null;
  messageId?: string | null;
}

export function CoachTurnActivity({
  activity,
  steps,
  active,
  awaitingAnswer = false,
  areas,
  method,
  dataUsed,
  conversationId,
  messageId,
}: CoachTurnActivityProps) {
  const { t, tCount, locale } = useTranslations();
  const panelId = useId();
  // Closed in every state; only the person's tap opens it.
  const [open, setOpen] = useState(false);
  // A row opened while the turn ran closes when it ends: the answer is
  // what the person came for. Adjusted while rendering, so the settled
  // row never paints open for a frame.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    setOpen(openAfter({ open, wasActive, active }));
  }

  // Only a persisted message whose live entries carry no text asks the
  // server for it, and only once the row is open.
  const needsStoredText =
    !active && activity.length > 0 && !activity.some((a) => a.title || a.text);
  const trail = useTrailText({
    conversationId,
    messageId,
    enabled: open && needsStoredText,
  });

  const areaLabels =
    activity.length === 0 && steps.length === 0
      ? legacyAreaLabels(areas, t)
      : [];
  const stepCount = activity.length || steps.length || areaLabels.length;
  const hasMethod = !active && !!method?.text;
  const hasDataUsed = !active && dataUsed != null && dataUsed !== false;
  const canOpen = stepCount > 0 || hasMethod || hasDataUsed;

  let line: string;
  if (active) {
    const entry = currentActivity(activity);
    const step = entry ? null : currentStep(steps);
    line = entry
      ? inProgressLabel(activityLineLabel(entry))
      : step
        ? inProgressLabel(stepLabel(step, t))
        : t(COACH_ACTIVITY_KEYS.thinking);
  } else if (awaitingAnswer) {
    line = t(COACH_ACTIVITY_KEYS.awaitingAnswer);
  } else {
    line = t(activityThoughtProcessKey(stepCount, locale), {
      count: stepCount,
    });
  }
  const announcement = useLineAnnouncement(line, active);

  // A settled message with nothing to show has no row at all.
  if (!active && !canOpen) return null;

  const state = active ? "running" : awaitingAnswer ? "awaiting" : "done";
  const isOpen = open && canOpen;

  const rowContent = (
    <>
      <Brain aria-hidden="true" className="size-4 shrink-0" />
      {active ? (
        <span
          aria-hidden="true"
          data-slot="coach-turn-steps-active"
          data-text={line}
          className="min-w-0 truncate"
        >
          <WaitingText text={line} textClassName="text-shimmer" />
        </span>
      ) : (
        <span data-slot="coach-turn-steps-done" className="min-w-0 truncate">
          {line}
        </span>
      )}
      {canOpen ? (
        <ChevronDown
          aria-hidden="true"
          data-slot="coach-turn-steps-chevron"
          className={cn(
            "size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-200",
            isOpen && "rotate-180",
          )}
        />
      ) : null}
    </>
  );
  // The row sits on the answer's left edge: its padding is taken back by
  // the same negative margin. On phones the 44 px target reaches into the
  // gap around it, so the row still sits close to the answer.
  const rowClass =
    "text-muted-foreground -mx-1.5 -my-1.5 flex min-h-11 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left leading-relaxed sm:my-0 sm:min-h-8";

  return (
    <div
      data-slot="coach-turn-steps"
      data-state={state}
      className="flex w-full max-w-full min-w-0 flex-col items-start self-stretch text-sm"
    >
      {canOpen ? (
        <button
          type="button"
          data-slot="coach-turn-steps-toggle"
          aria-expanded={isOpen}
          aria-controls={isOpen ? panelId : undefined}
          // While the turn runs the visible text changes with every step;
          // the status region announces it, so the button keeps a stable
          // name.
          {...(active
            ? {
                "aria-label": t(
                  isOpen
                    ? COACH_STEP_UI_KEYS.toggleHide
                    : COACH_STEP_UI_KEYS.toggleShow,
                ),
              }
            : {})}
          onClick={() => setOpen(!open)}
          className={cn(
            rowClass,
            "hover:text-foreground motion-safe:transition-colors",
            COACH_FOCUS_RING,
          )}
        >
          {rowContent}
        </button>
      ) : (
        <div data-slot="coach-turn-steps-row" className={rowClass}>
          {rowContent}
        </div>
      )}
      {isOpen ? (
        <div
          id={panelId}
          data-slot="coach-turn-steps-panel"
          className="motion-safe:animate-in motion-safe:fade-in-0 mt-2 flex w-full min-w-0 flex-col gap-3 motion-safe:duration-200"
        >
          {activity.length > 0 ? (
            <TrailList
              items={activityItems({
                activity,
                steps,
                trail,
                active,
                t,
                tCount,
              })}
              slot="coach-turn-activity-list"
              itemSlot="coach-turn-step"
              label={t(COACH_STEP_UI_KEYS.listLabel)}
            />
          ) : steps.length > 0 ? (
            <TrailList
              items={stepItems(steps, active, t, tCount)}
              slot="coach-turn-steps-list"
              itemSlot="coach-turn-step"
              label={t(COACH_STEP_UI_KEYS.listLabel)}
            />
          ) : areaLabels.length > 0 ? (
            <TrailList
              items={areaLabels.map((label) => ({
                key: label,
                icon: Database,
                label,
                tone: "done",
              }))}
              slot="coach-turn-areas"
              itemSlot="coach-turn-area"
              label={t(COACH_STEP_UI_KEYS.listLabel)}
            />
          ) : null}
          {hasMethod ? <CoachMethodLine method={method ?? null} /> : null}
          {hasDataUsed ? dataUsed : null}
        </div>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>
    </div>
  );
}
