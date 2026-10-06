"use client";

/**
 * v1.41 — the live trail of a Coach turn, one quiet line at the top of the
 * answer.
 *
 * While the turn runs the line says what the Coach is doing right now, from
 * the `activity` frames: "Thinking…", "Fetching blood pressure, last 90
 * days…", "Summarising 214 readings…", "Writing the answer…", with the
 * seconds so far right after the text. A reasoning title replaces the
 * thinking label when one arrives. Once the turn ends the same line settles
 * into one calm summary: "Thought it through, 3 lookups, 12 s".
 *
 * Nothing opens by itself. The trail starts closed in every state of a turn
 * (running, asking, stopped, failed, settled, reloaded) and only a tap on the
 * line opens it; it then stays open until the person closes it, and keeps
 * growing while the turn runs. Open, it lists one entry per phase with its
 * status, the reasoning text of a round behind its own disclosure (closed
 * too), the method line and the tables the answer used without pointing at
 * them.
 *
 * Labels are catalog text the server rendered; titles and texts are screened
 * model text the owner alone receives. A persisted message carries only the
 * metadata, so its titles and texts are read from `…/trail` the first time
 * the person opens the trail. A message saved before v1.41 has no activity
 * and falls back to the step list (`metricSource.steps`), and one saved
 * before steps existed to the areas it drew on.
 *
 * Screen readers hear the line through a polite status region, throttled to
 * one announcement per `ANNOUNCE_THROTTLE_MS` (the latest wins), and the
 * summary once when the turn ends. A reloaded conversation announces nothing.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Loader2,
  Minus,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
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
  activitySummaryKey,
} from "@/lib/ai/coach/activity/contract";
import type {
  CoachActivity,
  CoachMethod,
  CoachProvenanceMetric,
  CoachStep,
  CoachTrail,
} from "@/lib/ai/coach/types";

import { CoachMethodLine } from "./method-line";

/** The shortest gap between two screen-reader announcements. */
export const ANNOUNCE_THROTTLE_MS = 1500;

/** "12s": the seconds on the line and beside a finished round. */
const ELAPSED_KEY = "insights.coach.thinkingElapsed";

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
 * How many sources the turn looked at: one per domain (a step without one,
 * the snapshot, counts by its tool). A second read of the same domain, for
 * the period before or a retry, is not a new source.
 */
export function countSources(steps: readonly CoachStep[]): number {
  return new Set(steps.map((step) => step.domain ?? step.tool)).size;
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
 * What an entry is called on the line: a screened reasoning title for a
 * thinking round once one has arrived, else the server's catalog label.
 */
export function activityLineLabel(entry: CoachActivity): string {
  if (
    (entry.phase === "thinking" || entry.phase === "checkpoint") &&
    entry.title
  ) {
    return entry.title;
  }
  // A finished entry no longer trails off: "Writing the answer", not
  // "Writing the answer…".
  return entry.status === "running"
    ? entry.label
    : entry.label.replace(/(?:…|\.\.\.)\s*$/u, "");
}

/** The lookups a turn made: one per fetch. */
export function countLookups(activity: readonly CoachActivity[]): number {
  return activity.filter((entry) => entry.phase === "fetch").length;
}

/**
 * The seconds a turn took, from its trail: the phases of a round run one
 * after the other, except its fetches, which run side by side (the longest
 * counts). Null when the trail carries no durations.
 */
export function activitySeconds(
  activity: readonly CoachActivity[],
): number | null {
  const fetchByRound = new Map<number, number>();
  let sequential = 0;
  let any = false;
  for (const entry of activity) {
    if (entry.durationMs === undefined) continue;
    any = true;
    if (entry.phase === "fetch") {
      fetchByRound.set(
        entry.round,
        Math.max(fetchByRound.get(entry.round) ?? 0, entry.durationMs),
      );
    } else {
      sequential += entry.durationMs;
    }
  }
  if (!any) return null;
  let total = sequential;
  for (const ms of fetchByRound.values()) total += ms;
  return Math.max(1, Math.round(total / 1000));
}

/** Whole seconds between two instants, at least one. */
export function elapsedSeconds(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 1000));
}

/**
 * The settled line: "Thought it through, N lookups, S s". The seconds come
 * from the trail, else from the clock of the turn that just streamed. Null
 * when neither is known (a message saved before v1.41).
 */
export function activitySummary(args: {
  activity: readonly CoachActivity[];
  startedAt?: number | null;
  endedAt?: number | null;
  t: Translate;
  locale: Locale;
}): string | null {
  const { activity, startedAt, endedAt, t, locale } = args;
  if (activity.length === 0) return null;
  const seconds =
    activitySeconds(activity) ??
    (startedAt && endedAt ? elapsedSeconds(startedAt, endedAt) : null);
  if (seconds === null) return null;
  const lookups = countLookups(activity);
  return t(activitySummaryKey(lookups, locale), { lookups, seconds });
}

/** A tick per second while `running`; the current time otherwise. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/**
 * The status region's text: the running line as it changes, throttled, and
 * the summary once when the turn ends. Nothing is announced for a trail that
 * was already settled when it mounted.
 */
function useLineAnnouncement(text: string, active: boolean): string {
  const [mountedActive] = useState(active);
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const said = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    // A reloaded, settled trail stays quiet.
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

// ── Rendering ──────────────────────────────────────────────────────────────

type EntryStatus = CoachActivity["status"];

function StatusIcon({
  status,
  active,
}: {
  status: EntryStatus;
  active: boolean;
}) {
  const className = "mt-0.5 size-3 shrink-0";
  if (status === "running" && active) {
    return (
      <Loader2
        aria-hidden="true"
        className={cn(
          className,
          "text-muted-foreground animate-spin motion-reduce:animate-none",
        )}
      />
    );
  }
  if (status === "done" || status === "running") {
    return (
      <Check
        aria-hidden="true"
        className={cn(className, "text-muted-foreground")}
      />
    );
  }
  if (status === "failed") {
    return (
      <TriangleAlert
        aria-hidden="true"
        className={cn(className, "text-warning")}
      />
    );
  }
  return (
    <Minus
      aria-hidden="true"
      className={cn(className, "text-muted-foreground")}
    />
  );
}

/** The rows of a legacy step list: one per step, in the order they started. */
export function CoachTurnStepList({
  id,
  steps,
  active,
}: {
  id?: string;
  steps: CoachStep[];
  active: boolean;
}) {
  const { t, tCount } = useTranslations();
  return (
    <ol
      id={id}
      data-slot="coach-turn-steps-list"
      aria-label={t(COACH_STEP_UI_KEYS.listLabel)}
      className="flex flex-col gap-1"
    >
      {steps.map((step) => {
        const { title, meta } = describeStep(step, t, tCount);
        return (
          <li
            key={step.id}
            data-slot="coach-turn-step"
            data-status={step.status}
            className="flex items-start gap-1.5 leading-relaxed"
          >
            <StatusIcon status={step.status} active={active} />
            <span className="text-muted-foreground min-w-0">
              <span className="text-foreground">{title}</span>
              <StepMeta parts={meta} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StepMeta({ parts }: { parts: string[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          <span aria-hidden="true"> · </span>
          {/* The comma is for a screen reader only. `select-none` keeps it
              out of a copied row. */}
          <span className="sr-only select-none">, </span>
          {part}
        </span>
      ))}
    </>
  );
}

/**
 * One trail entry. A fetch backed by a step reads like a step row (domain,
 * window, count); everything else shows its label and, once finished, how
 * long it took. A thinking round with reasoning text, and the memory entry
 * with the things it recalled, open their detail on their own tap.
 */
function ActivityEntry({
  entry,
  step,
  active,
  detail,
}: {
  entry: CoachActivity;
  step: CoachStep | undefined;
  active: boolean;
  detail: { text?: string; recalled?: string[] } | null;
}) {
  const { t, tCount } = useTranslations();
  const detailId = useId();
  const [open, setOpen] = useState(false);
  let title: string;
  let meta: string[] = [];
  if (entry.phase === "fetch" && step) {
    ({ title, meta } = describeStep(step, t, tCount));
  } else {
    title = activityLineLabel(entry);
    if (entry.status !== "running" && entry.durationMs !== undefined) {
      meta = [
        t(ELAPSED_KEY, {
          seconds: Math.max(1, Math.round(entry.durationMs / 1000)),
        }),
      ];
    }
  }
  const hasDetail =
    !!detail?.text ||
    (detail?.recalled !== undefined && detail.recalled.length > 0);
  return (
    <li
      data-slot="coach-turn-step"
      data-phase={entry.phase}
      data-status={entry.status}
      className="relative flex items-start gap-1.5 leading-relaxed"
    >
      <StatusIcon status={entry.status} active={active} />
      <div className="flex min-w-0 flex-col gap-1">
        {hasDetail ? (
          <button
            type="button"
            data-slot="coach-turn-step-detail-toggle"
            aria-expanded={open}
            aria-controls={open ? detailId : undefined}
            onClick={() => setOpen(!open)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-input-focus flex w-fit max-w-full items-start gap-1 rounded text-left outline-none focus-visible:ring-2"
          >
            <span className="min-w-0">
              <span className="text-foreground">{title}</span>
              <StepMeta parts={meta} />
            </span>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-3 shrink-0 motion-safe:transition-transform",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="text-muted-foreground min-w-0">
            <span className="text-foreground">{title}</span>
            <StepMeta parts={meta} />
          </span>
        )}
        {hasDetail && open ? (
          <div
            id={detailId}
            data-slot="coach-turn-step-detail"
            className="text-foreground flex flex-col gap-1"
          >
            {detail?.text ? (
              <p className="whitespace-pre-wrap">{detail.text}</p>
            ) : null}
            {detail?.recalled?.length ? (
              <ul className="flex flex-col gap-0.5">
                {detail.recalled.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The open trail: the entries (or a legacy message's steps or areas), then
 * the method line, then the tables the answer used. One left rule holds
 * them together.
 */
function CoachTurnActivityPanel({
  id,
  activity,
  steps,
  active,
  areaLabels,
  trail,
  method,
  dataUsed,
}: {
  id: string;
  activity: CoachActivity[];
  steps: CoachStep[];
  active: boolean;
  areaLabels: string[];
  trail: CoachTrail | null;
  method?: CoachMethod | null;
  dataUsed?: ReactNode;
}) {
  const { t } = useTranslations();
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const textById = new Map(
    (trail?.entries ?? []).map((entry) => [entry.id, entry]),
  );
  return (
    <div
      id={id}
      data-slot="coach-turn-steps-panel"
      className="border-border mt-1.5 ml-1.5 flex min-w-0 flex-col gap-2 border-l pl-2.5"
    >
      {activity.length > 0 ? (
        <ol
          data-slot="coach-turn-activity-list"
          aria-label={t(COACH_STEP_UI_KEYS.listLabel)}
          className="flex flex-col gap-1"
        >
          {activity.map((entry) => {
            const stored = textById.get(entry.id);
            const merged: CoachActivity = {
              ...entry,
              title: entry.title ?? stored?.title,
              text: entry.text ?? stored?.text,
            };
            const detail =
              entry.phase === "memory"
                ? { recalled: trail?.recalled }
                : merged.text
                  ? { text: merged.text }
                  : null;
            return (
              <ActivityEntry
                key={entry.id}
                entry={merged}
                step={entry.stepRef ? stepsById.get(entry.stepRef) : undefined}
                active={active}
                detail={detail}
              />
            );
          })}
        </ol>
      ) : steps.length > 0 ? (
        <CoachTurnStepList steps={steps} active={active} />
      ) : areaLabels.length > 0 ? (
        <ul
          data-slot="coach-turn-areas"
          aria-label={t(COACH_STEP_UI_KEYS.listLabel)}
          className="flex flex-col gap-1"
        >
          {areaLabels.map((label) => (
            <li
              key={label}
              data-slot="coach-turn-area"
              className="text-foreground flex items-start gap-1.5 leading-relaxed"
            >
              <Check
                aria-hidden="true"
                className="text-muted-foreground mt-0.5 size-3 shrink-0"
              />
              <span className="min-w-0">{label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!active && <CoachMethodLine method={method ?? null} />}
      {!active && dataUsed}
    </div>
  );
}

export interface CoachTurnActivityProps {
  /** The live trail, or `metricSource.activity` of a persisted message. */
  activity: CoachActivity[];
  /** The steps the fetch entries point at; a legacy message's whole list. */
  steps: CoachStep[];
  /** True while the turn is still running. */
  active: boolean;
  /** When the live turn started and ended on this device (epoch ms). */
  startedAt?: number | null;
  endedAt?: number | null;
  /**
   * The provenance metrics, for a message saved before steps existed. Read
   * only when there is neither activity nor steps.
   */
  areas?: readonly CoachProvenanceMetric[];
  /** How the answer was worked out; shown at the end of the open trail. */
  method?: CoachMethod | null;
  /**
   * The tables the answer read without pointing at them, shown last in the
   * open trail. Pass it only when there is something to show.
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
  startedAt,
  endedAt,
  areas,
  method,
  dataUsed,
  conversationId,
  messageId,
}: CoachTurnActivityProps) {
  const { t, tCount, locale } = useTranslations();
  const panelId = useId();
  // Closed in every state; only the person's tap opens it, and it stays as
  // they left it (also across the swap to the persisted copy, which keeps
  // this component).
  const [open, setOpen] = useState(false);
  const now = useNow(active);

  // Only a persisted message whose live entries carry no text asks the
  // server for it, and only once the trail is open.
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
  const hasMethod = !active && !!method?.text;
  const hasDataUsed = !active && dataUsed != null && dataUsed !== false;

  let line: string;
  if (active) {
    const entry = currentActivity(activity);
    const step = entry ? null : currentStep(steps);
    line = entry
      ? activityLineLabel(entry)
      : step
        ? stepLabel(step, t)
        : t(COACH_ACTIVITY_KEYS.thinking);
  } else {
    line =
      activitySummary({ activity, startedAt, endedAt, t, locale }) ??
      (steps.length > 0
        ? tCount("coach.step.headerDone", countSources(steps))
        : areaLabels.length > 0
          ? tCount("insights.coach.answer.areasDone", areaLabels.length)
          : t(COACH_STEP_UI_KEYS.listLabel));
  }
  const announcement = useLineAnnouncement(line, active);

  // A settled message with nothing to show has no line at all.
  if (
    !active &&
    activity.length === 0 &&
    steps.length === 0 &&
    areaLabels.length === 0 &&
    !hasMethod &&
    !hasDataUsed
  ) {
    return null;
  }

  const seconds =
    active && startedAt
      ? elapsedSeconds(startedAt, Math.max(now, startedAt))
      : null;

  return (
    <div
      data-slot="coach-turn-steps"
      data-state={active ? "running" : "done"}
      className="flex w-full max-w-full min-w-0 flex-col self-stretch text-xs"
    >
      <button
        type="button"
        data-slot="coach-turn-steps-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // While the turn runs the visible text changes with every phase; the
        // status region announces it, so the button keeps a stable name.
        {...(active
          ? {
              "aria-label": t(
                open
                  ? COACH_STEP_UI_KEYS.toggleHide
                  : COACH_STEP_UI_KEYS.toggleShow,
              ),
            }
          : {})}
        onClick={() => setOpen(!open)}
        className={cn(
          // A 44 px target on phones whose extra height reaches into the gap
          // around it, so the line still sits close to the answer; beside a
          // pointer the line is as tall as the avatar it sits next to.
          "text-muted-foreground hover:text-foreground -my-1.5 flex min-h-11 w-full max-w-full min-w-0 items-center gap-1.5 sm:my-0 sm:min-h-8",
          "focus-visible:ring-input-focus rounded text-left leading-relaxed outline-none focus-visible:ring-2",
        )}
      >
        {active ? (
          <Loader2
            aria-hidden="true"
            data-slot="coach-turn-steps-spinner"
            className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 motion-safe:transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        {active ? (
          <span
            aria-hidden="true"
            data-slot="coach-turn-steps-active"
            className="min-w-0 truncate"
          >
            {line}
          </span>
        ) : (
          <span data-slot="coach-turn-steps-done" className="min-w-0 truncate">
            {line}
          </span>
        )}
        {/* The seconds follow the text they time, in the same muted tone,
            so the line reads as one phrase rather than a label and a
            counter at the far edge of the column. */}
        {seconds !== null ? (
          <span
            aria-hidden="true"
            data-slot="coach-turn-steps-seconds"
            className="shrink-0 tabular-nums"
          >
            {t(ELAPSED_KEY, { seconds })}
          </span>
        ) : null}
      </button>
      {open && (
        <CoachTurnActivityPanel
          id={panelId}
          activity={activity}
          steps={steps}
          active={active}
          areaLabels={areaLabels}
          trail={trail}
          method={method}
          dataUsed={hasDataUsed ? dataUsed : null}
        />
      )}
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
