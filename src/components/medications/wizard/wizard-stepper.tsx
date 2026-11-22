"use client";

/**
 * v1.8.6 — dot/bullet stepper for the medication wizard.
 *
 * Replaces the continuous `<Progress>` bar + "Step X of Y" caption with
 * one dot per path slot (so the one-shot path shows 5 dots, the
 * recurring path 8 — the dialog feeds the mode/cadence-aware `stepList`
 * straight in, so the dot count auto-collapses live). Each dot is a
 * button: completed + reachable dots jump on click, future dots gate on
 * the dialog's multi-step `validateStep` lookahead (`reachableUntil`).
 * `SkipBack` / `SkipForward` flank the row for jump-to-first /
 * jump-to-last.
 *
 * Purely presentational — every gating decision is computed in the
 * dialog (`goToStep` + `reachableUntil`) so the stepper stays dumb.
 * Connectors run dashed for not-yet-reached segments and solid for
 * completed ones, giving the "bullets, not one continuous line" feel.
 */

import { SkipBack, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WizardStepperProps {
  /** Ordered raw step numbers for the active mode + cadence path. */
  steps: readonly number[];
  /** The raw step number the body currently renders. */
  current: number;
  /**
   * Path-index ceiling (exclusive upper bound) of forward-reachable
   * slots. A slot at index `j` is reachable iff `j <= reachableUntil`.
   * The dialog computes it from the `validateStep` lookahead.
   */
  reachableUntil: number;
  /** Short per-step label keyed by raw step number. */
  labels: Record<number, string>;
  /** Jump to a raw step number. */
  onJump: (step: number) => void;
  onFirst: () => void;
  onLast: () => void;
  firstEnabled: boolean;
  lastEnabled: boolean;
  /** Accessible labels for the flanking jump buttons. */
  firstLabel: string;
  lastLabel: string;
  /** Accessible group label, e.g. "Step 4 of 8". */
  srLabel: string;
}

export function WizardStepper({
  steps,
  current,
  reachableUntil,
  labels,
  onJump,
  onFirst,
  onLast,
  firstEnabled,
  lastEnabled,
  firstLabel,
  lastLabel,
  srLabel,
}: WizardStepperProps) {
  const currentIndex = steps.indexOf(current);
  // When the step pointer is briefly off-path (e.g. Step 5 after the
  // mode collapses the path), pin the active slot to the last slot at
  // or before the current step so the active dot never disappears.
  const activeIndex =
    currentIndex >= 0
      ? currentIndex
      : steps.reduce((acc, n, i) => (n <= current ? i : acc), 0);

  const activeStepNumber = steps[activeIndex];
  const activeLabel =
    labels[activeStepNumber] ?? String(activeStepNumber ?? current);

  return (
    <div
      className="flex flex-col gap-1.5"
      data-slot="wizard-stepper"
      role="group"
      aria-label={srLabel}
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
          onClick={onFirst}
          disabled={!firstEnabled}
          data-slot="wizard-stepper-first"
          aria-label={firstLabel}
        >
          <SkipBack className="h-4 w-4" aria-hidden="true" />
        </Button>

        <ol className="flex min-w-0 flex-1 items-center justify-between">
          {steps.map((stepNumber, index) => {
            const isActive = index === activeIndex;
            const isCompleted = index < activeIndex;
            const isReachable = index <= reachableUntil;
            const label = labels[stepNumber] ?? String(stepNumber);
            // Backward + current are always navigable; forward is gated
            // on the reachability ceiling.
            const enabled = index <= activeIndex || isReachable;
            // A connector segment leads INTO this dot from the previous
            // one; it reads "completed" (solid) once we've passed it.
            const connectorSolid = index <= activeIndex;

            return (
              <li
                key={stepNumber}
                className={cn(
                  "flex min-w-0 items-center",
                  index === 0 ? "flex-initial" : "flex-1",
                )}
              >
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mx-1 h-0 flex-1 border-t",
                      connectorSolid
                        ? "border-primary"
                        : "border-muted-foreground/30 border-dashed",
                    )}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onJump(stepNumber)}
                  disabled={!enabled}
                  data-slot="wizard-stepper-dot"
                  data-step-dot={stepNumber}
                  data-active={isActive || undefined}
                  data-completed={isCompleted || undefined}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`${index + 1}. ${label}`}
                  className={cn(
                    // The dot paints at 28 px. The hit area around it is
                    // 44 px tall and 36 px wide: eight dots share a 390 px
                    // row, so a wider one would reach into its neighbour.
                    "group focus-visible:ring-ring/50 relative flex shrink-0 flex-col items-center gap-1 rounded-md p-2 transition-colors before:absolute before:-inset-x-1 before:-inset-y-2 before:content-[''] focus-visible:ring-2 focus-visible:outline-none",
                    enabled
                      ? "cursor-pointer"
                      : "cursor-not-allowed opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-3 w-3 place-items-center rounded-full border transition-colors",
                      isActive
                        ? "border-primary bg-primary ring-primary/30 ring-2 ring-offset-1 ring-offset-transparent"
                        : isCompleted
                          ? "border-primary bg-primary"
                          : isReachable
                            ? "border-primary bg-transparent"
                            : "border-muted-foreground/30 bg-transparent",
                    )}
                  />
                  <span
                    className={cn(
                      "text-2xs max-w-[6rem] truncate leading-none",
                      isActive
                        ? "text-foreground font-medium"
                        : "text-muted-foreground",
                      // Crowding guard: narrow viewports drop the per-dot
                      // labels entirely (the caption below names the active
                      // step instead); from `sm+` every dot is labelled.
                      "hidden sm:inline",
                    )}
                  >
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 shrink-0 before:absolute before:-inset-1.5 before:content-['']"
          onClick={onLast}
          disabled={!lastEnabled}
          data-slot="wizard-stepper-last"
          aria-label={lastLabel}
        >
          <SkipForward className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Compact caption — on narrow viewports the per-dot labels collapse
          to the active dot only, so this line names where the user stands
          ("Step 4 of 8 · How often") instead of leaving bare dots. Hidden
          from `sm+` where every dot carries its own label, and aria-hidden
          because the group already announces `srLabel`. */}
      <p
        className="text-muted-foreground truncate text-xs sm:hidden"
        aria-hidden="true"
        data-slot="wizard-stepper-caption"
      >
        {srLabel} · {activeLabel}
      </p>
    </div>
  );
}
