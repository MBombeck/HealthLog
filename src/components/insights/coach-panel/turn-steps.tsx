"use client";

/**
 * v1.39.4 — what the Coach read on a turn: a compact list of steps above
 * the answer, live while the turn runs (from the `step` frames) and
 * restored from `metricSource.steps` on reload.
 *
 * While the turn runs the header names the step in progress ("Reading
 * Blood pressure, last 90 days…") with a soft shimmer; once it ends the
 * header folds into "Looked at 3 sources" and the list closes. The list
 * itself is one row per step: domain, window, and a count or the reason
 * nothing was found. Everything shown comes from catalog keys and the
 * server's enums and counts; a row never shows a value, a tool argument or
 * model text.
 *
 * The open list also says how the answer was worked out (the method line)
 * and holds the tables the answer read without pointing at them. An older
 * message saved before steps existed folds into "Looked at 3 areas" and
 * lists the areas from its provenance, without counts; a metric token the
 * bundle has no name for is left out rather than shown as a raw key.
 *
 * Screen readers hear each completed step once, through a polite status
 * region, at most one announcement per `ANNOUNCE_THROTTLE_MS` (the latest
 * wins). A reloaded conversation announces nothing.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Loader2,
  Minus,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import {
  COACH_STEP_REASON_KEYS,
  COACH_STEP_UI_KEYS,
  coachDomainLabelKey,
  coachGranularityLabelKey,
  coachPeriodLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import type {
  CoachMethod,
  CoachProvenanceMetric,
  CoachStep,
} from "@/lib/ai/coach/types";

import { CoachMethodLine } from "./method-line";

export interface CoachTurnStepsProps {
  steps: CoachStep[];
  /** True while the turn is still running. */
  active: boolean;
}

export interface CoachTurnStepsDetailProps extends CoachTurnStepsProps {
  /**
   * The provenance metrics, for a message saved before steps existed. Read
   * only when `steps` is empty.
   */
  areas?: readonly CoachProvenanceMetric[];
  /** How the answer was worked out; shown at the end of the open list. */
  method?: CoachMethod | null;
  /**
   * The tables the answer read without pointing at them, shown last in the
   * open list. Pass it only when there is something to show.
   */
  dataUsed?: ReactNode;
}

/** The shortest gap between two screen-reader announcements. */
export const ANNOUNCE_THROTTLE_MS = 1500;

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

function rowText(step: CoachStep, t: Translate, tCount: TranslateCount) {
  const { title, meta } = describeStep(step, t, tCount);
  return [title, ...meta].join(" · ");
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
 * The step the active header names: the latest one still running, else the
 * latest one overall (between two rounds nothing is running).
 */
export function currentStep(steps: CoachStep[]): CoachStep | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status === "running") return steps[i];
  }
  return steps.at(-1) ?? null;
}

/**
 * The newest settled step the reader has not been told about yet, given the
 * ids already announced (or present when the list mounted). Null when there
 * is nothing new.
 */
export function nextAnnouncement(
  steps: CoachStep[],
  told: ReadonlySet<string>,
): CoachStep | null {
  let latest: CoachStep | null = null;
  for (const step of steps) {
    if (step.status !== "running" && !told.has(step.id)) latest = step;
  }
  return latest;
}

/**
 * The status region's text: each newly settled step, throttled. Steps that
 * were already settled when the list mounted are never announced, so a
 * reloaded conversation stays quiet.
 */
function useStepAnnouncement(
  steps: CoachStep[],
  describe: (step: CoachStep) => string,
): string {
  // Mutable on purpose: the ids the reader has been told about, seeded with
  // whatever was already settled at mount.
  const [told] = useState(
    () => new Set(steps.filter((s) => s.status !== "running").map((s) => s.id)),
  );
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    const next = nextAnnouncement(steps, told);
    if (!next) return;
    for (const step of steps) {
      if (step.status !== "running") told.add(step.id);
    }
    const nextText = describe(next);
    const wait = Math.max(
      0,
      lastAt.current + ANNOUNCE_THROTTLE_MS - Date.now(),
    );
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      setText(nextText);
    }, wait);
  }, [steps, describe, told]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return text;
}

function StepIcon({ step, active }: { step: CoachStep; active: boolean }) {
  const className = "mt-0.5 size-3 shrink-0";
  if (step.status === "running" && active) {
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
  if (step.status === "done") {
    return (
      <Check
        aria-hidden="true"
        className={cn(className, "text-muted-foreground")}
      />
    );
  }
  if (step.status === "failed") {
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

/** The rows under the header: one per step, in the order they started. */
export function CoachTurnStepList({
  id,
  steps,
  active,
}: CoachTurnStepsProps & { id?: string }) {
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
            <StepIcon step={step} active={active} />
            <span className="text-muted-foreground min-w-0">
              <span className="text-foreground/80">{title}</span>
              {meta.map((part, i) => (
                <span key={i}>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  {part}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The open list: the steps (or an older message's areas), then the method
 * line, then the tables the answer read. One left rule holds them together.
 */
export function CoachTurnStepsPanel({
  id,
  steps,
  active,
  areaLabels,
  method,
  dataUsed,
}: CoachTurnStepsProps & {
  id?: string;
  areaLabels: string[];
  method?: CoachMethod | null;
  dataUsed?: ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div
      id={id}
      data-slot="coach-turn-steps-panel"
      className="border-border/60 mt-1.5 ml-1.5 flex min-w-0 flex-col gap-2 border-l pl-2.5"
    >
      {steps.length > 0 ? (
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
              className="text-foreground/80 flex items-start gap-1.5 leading-relaxed"
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

export function CoachTurnSteps({
  steps,
  active,
  areas,
  method,
  dataUsed,
}: CoachTurnStepsDetailProps) {
  const { t, tCount } = useTranslations();
  const listId = useId();
  // Closed by default; the reader's toggle holds until the turn ends, and
  // the list folds away again when it does.
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    setOpenOverride(null);
  }
  const announcement = useStepAnnouncement(steps, (step) =>
    t(COACH_STEP_UI_KEYS.announceDone, { label: rowText(step, t, tCount) }),
  );

  const areaLabels = steps.length === 0 ? legacyAreaLabels(areas, t) : [];
  const hasMethod = !active && !!method?.text;
  const hasDataUsed = !active && dataUsed != null && dataUsed !== false;
  if (
    steps.length === 0 &&
    areaLabels.length === 0 &&
    !hasMethod &&
    !hasDataUsed
  ) {
    return null;
  }
  const open = openOverride ?? false;
  const current = active ? currentStep(steps) : null;
  const header = current
    ? null
    : steps.length > 0
      ? tCount("coach.step.headerDone", countSources(steps))
      : areaLabels.length > 0
        ? tCount("insights.coach.answer.areasDone", areaLabels.length)
        : t(COACH_STEP_UI_KEYS.listLabel);

  return (
    <div
      data-slot="coach-turn-steps"
      className="flex w-full max-w-full min-w-0 flex-col self-stretch text-xs"
    >
      <button
        type="button"
        data-slot="coach-turn-steps-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // While the turn runs the visible text changes with every step; the
        // status region below announces completions, so the button keeps a
        // stable name instead of re-announcing each label.
        {...(current
          ? {
              "aria-label": t(
                open
                  ? COACH_STEP_UI_KEYS.toggleHide
                  : COACH_STEP_UI_KEYS.toggleShow,
              ),
            }
          : {})}
        onClick={() => setOpenOverride(!open)}
        className={cn(
          "text-muted-foreground hover:text-foreground flex w-fit max-w-full items-center gap-1.5",
          "focus-visible:ring-ring/50 rounded text-left leading-relaxed outline-none focus-visible:ring-2",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 motion-safe:transition-transform",
            open && "rotate-90",
          )}
        />
        {current ? (
          <span
            aria-hidden="true"
            data-slot="coach-turn-steps-active"
            className="skeleton-shimmer min-w-0 truncate rounded"
          >
            {t(COACH_STEP_UI_KEYS.headerActive, {
              label: stepLabel(current, t),
            })}
          </span>
        ) : (
          <span data-slot="coach-turn-steps-done" className="min-w-0 truncate">
            {header}
          </span>
        )}
      </button>
      {open && (
        <CoachTurnStepsPanel
          id={listId}
          steps={steps}
          active={active}
          areaLabels={areaLabels}
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
