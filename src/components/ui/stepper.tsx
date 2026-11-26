"use client";

import { cn } from "@/lib/utils";

/**
 * The progress band of a flow with a fixed number of steps.
 *
 * One segment per step, all of the same width whatever their labels say, so
 * the band reads the same at every step and on every path. A step that spans
 * several screens fills its own segment part-way (`fraction`); the number of
 * segments never changes under the person's finger.
 *
 * Phones: the current step's name on the left and "Step n of N" on the right,
 * above the segments. From `md` the names sit under their segments and the
 * count stays at the top right.
 *
 * Two colours only: primary for what is done, the track token for what is
 * not. The current step is marked by its label weight, the count and
 * `aria-current`, never by a third colour or a larger mark.
 *
 * A segment is a button only when `onStepSelect` is given and its index is at
 * or below `reachableUntil`; the current one never is. The caller decides
 * what reachable means and where a jump lands.
 */
export interface StepperStep {
  id: string;
  label: string;
}

export interface StepperProps {
  /** The flow's steps, fixed for the whole flow (3 to 6). */
  steps: ReadonlyArray<StepperStep>;
  /** Index of the current step. */
  current: number;
  /** How far the current step is filled, 0 to 1. Defaults to 1. */
  fraction?: number;
  /** "Step n of N", already translated; also the band's accessible name. */
  countLabel: string;
  /** Highest index a tap may jump to. Defaults to `current`. */
  reachableUntil?: number;
  /** Called with the index of a tapped segment. Omit for a passive band. */
  onStepSelect?: (index: number) => void;
  className?: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function Stepper({
  steps,
  current,
  fraction = 1,
  countLabel,
  reachableUntil = current,
  onStepSelect,
  className,
}: StepperProps) {
  const currentStep = steps[current];
  return (
    <nav
      aria-label={countLabel}
      data-slot="stepper"
      data-current={current}
      data-count={steps.length}
      className={cn("flex flex-col gap-2", className)}
    >
      {/* The caption repeats what the band's name and `aria-current` already
          say, so it is hidden from assistive technology. */}
      <div className="flex items-baseline gap-3" aria-hidden="true">
        <p
          className="text-foreground min-w-0 flex-1 truncate text-sm font-medium md:invisible"
          data-slot="stepper-current-label"
        >
          {currentStep?.label}
        </p>
        <p
          className="text-muted-foreground shrink-0 text-xs tabular-nums"
          data-slot="stepper-count"
        >
          {countLabel}
        </p>
      </div>
      <ol
        className="grid gap-1 md:gap-2"
        style={{
          gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))`,
        }}
      >
        {steps.map((step, index) => {
          const isCurrent = index === current;
          const fill = index < current ? 1 : isCurrent ? clamp01(fraction) : 0;
          const selectable =
            onStepSelect !== undefined && !isCurrent && index <= reachableUntil;
          const body = (
            <>
              <span
                className="bg-progress-track relative block h-1 w-full overflow-hidden rounded-full forced-colors:border"
                aria-hidden="true"
              >
                <span
                  className={cn(
                    "bg-primary absolute inset-y-0 left-0 rounded-full duration-200 motion-safe:transition-[width]",
                    fill > 0 && "forced-colors:border-2",
                  )}
                  style={{ width: `${fill * 100}%` }}
                  data-slot="stepper-fill"
                />
              </span>
              <span
                className={cn(
                  "mt-1.5 hidden truncate text-left text-xs md:block",
                  isCurrent
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
              {/* Phones show no label under a segment; the name still
                  belongs to it for a screen reader. */}
              <span className="sr-only md:hidden">{step.label}</span>
            </>
          );
          return (
            <li
              key={step.id}
              aria-current={isCurrent ? "step" : undefined}
              data-slot="stepper-step"
              data-step-id={step.id}
              data-state={
                index < current ? "done" : isCurrent ? "current" : "upcoming"
              }
              data-fill={fill}
              className="min-w-0"
            >
              {selectable ? (
                <button
                  type="button"
                  onClick={() => onStepSelect(index)}
                  data-slot="stepper-step-button"
                  className={cn(
                    "group focus-visible:ring-ring/50 relative block w-full cursor-pointer rounded-sm py-1 focus-visible:ring-[3px] focus-visible:outline-none",
                    // 44 px tall on a finger without taking room: the band
                    // stays four pixels high on a phone.
                    "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-1/2 pointer-coarse:before:h-11 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div className="py-1">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
