"use client";

/**
 * v1.5.4 — Modal medication-creation wizard.
 *
 * Replaces the v1.5.3 `<CreationWizard>` card with a popup that lives
 * inside `<ResponsiveSheet>` (centred dialog on `md+`, bottom sheet on
 * narrow viewports). The dialog renders its own header inside the
 * body — counter + icon plate + title + subline — followed by the
 * step's single focused field, and a sticky footer with Back / Next
 * (or Save / Änderungen speichern).
 *
 * Path tables — visible counter follows the route the user walks:
 *
 *   ONE_SHOT_PATH  = [1, 2, 3, 4, 8]
 *   DAILY_PATH     = [1, 2, 3, 4, 5, 7, 8]
 *   RECURRING_PATH = [1, 2, 3, 4, 5, 6, 7, 8]
 *
 * The same component drives create AND edit. On edit the body
 * hydrates from `MedicationPayload`, the header title flips to
 * "{name} bearbeiten", and the final CTA flips to
 * "Änderungen speichern".
 *
 * i18n namespace: `medications.wizard.*`. Cadence row labels +
 * descriptions live under `medications.wizard.cadence.*` so the
 * locale-integrity guard surfaces every missing key the moment the
 * dialog reaches a new locale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bell,
  CalendarRange,
  ChevronRight,
  Clock,
  FlaskConical,
  Loader2,
  Pill,
  Repeat,
  Sparkles,
  Tag,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

import { NaturalLanguageExtractor } from "@/components/medications/scheduling/natural-language-extractor";

import {
  addSchedule,
  buildCreateBody,
  commitActiveDraft,
  emptyWizardPayload,
  firstInvalidIndex,
  hydrateWizardPayload,
  landingStepForEdit,
  type MedicationPayload,
  progressIndices,
  removeSchedule,
  setActiveSchedule,
  type WizardPayload,
} from "./wizard-payload";
import { WizardStepper } from "./wizard-stepper";
import { Step1Name } from "./steps/step1-name";
import { Step2Class } from "./steps/step2-class";
import { Step3Dose } from "./steps/step3-dose";
import { Step4Window } from "./steps/step4-window";
import { Step5Cadence } from "./steps/step5-cadence";
import { Step6SubCadence } from "./steps/step6-sub-cadence";
import { Step7Times } from "./steps/step7-times";
import { Step8Summary } from "./steps/step8-summary";
import { validateStep } from "./wizard-payload";
import { extractorToWizardPartial } from "./nl-bridge";

export interface MedicationWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Required when `mode === "edit"`. */
  initial?: MedicationPayload;
  /** Fires with the medication id on a successful create / save. */
  onSuccess?: (id: string) => void;
}

const STEP_ICONS = {
  1: Pill,
  2: Tag,
  3: FlaskConical,
  4: CalendarRange,
  5: Repeat,
  6: Repeat,
  7: Clock,
  8: Bell,
} as const;

type StepNumber = keyof typeof STEP_ICONS;

export function MedicationWizardDialog(props: MedicationWizardDialogProps) {
  // Key the inner state container on (open + mode + medication id) so
  // every open gets a fresh state tree. React unmounts the inner
  // component when the key changes, which sidesteps the "setState in
  // useEffect" anti-pattern that resetting on open via an effect would
  // otherwise trigger. The outer shell stays mounted so the dialog's
  // close animation runs cleanly.
  const stateKey = `${props.open ? "open" : "closed"}:${props.mode}:${props.initial?.id ?? "new"}`;
  return <WizardDialogShell key={stateKey} {...props} />;
}

function WizardDialogShell({
  open,
  onOpenChange,
  mode,
  initial,
  onSuccess,
}: MedicationWizardDialogProps) {
  const { t, locale } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [payload, setPayload] = useState<WizardPayload>(() =>
    mode === "edit" && initial
      ? hydrateWizardPayload(initial)
      : emptyWizardPayload(),
  );
  const [step, setStep] = useState<StepNumber>(() => {
    if (mode === "edit" && initial) {
      const hydrated = hydrateWizardPayload(initial);
      return landingStepForEdit(hydrated) as StepNumber;
    }
    return 1;
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nlOpen, setNlOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // v1.5.5 H-cluster-B / D-3 §8 — title focus on landing ≠ 1. The
  // `tabIndex={-1}` heading announces the new step on intent-routed
  // edit-opens (e.g. cadence row → Step 5) so the screen reader hears
  // "Step 5 of 8 — How often" instead of the first input on the step.
  const stepTitleRef = useRef<HTMLHeadingElement | null>(null);
  const isFirstRenderRef = useRef(true);

  const applyPartial = useCallback((partial: Partial<WizardPayload>) => {
    setPayload((prev) => ({ ...prev, ...partial }));
  }, []);

  const stepList = useMemo(
    () => progressIndices(payload.mode, payload.cadence.kind),
    [payload.mode, payload.cadence.kind],
  );
  const totalSteps = stepList.length;
  // The displayed counter prefers the slot the current step lives
  // in. When the step pointer drifts off-path (e.g. picking
  // "Einmalig" on Step 5 collapses the path to `[1, 2, 3, 4, 8]`),
  // the counter pins on the slot whose step number is `<= step` so
  // the body keeps rendering the user's actual current step and
  // the visible counter doesn't jump ahead of them.
  const currentIndex = stepList.indexOf(step);
  const fallbackIndex = (() => {
    if (currentIndex >= 0) return currentIndex;
    let last = 0;
    for (let i = 0; i < stepList.length; i++) {
      if (stepList[i] <= step) last = i;
    }
    return last;
  })();
  const displayStep = fallbackIndex + 1;
  const isLastStep = displayStep === totalSteps;
  const isFirstStep = displayStep === 1;

  // v1.8.6 W4b — forward-reachability ceiling for the dot stepper. The
  // dot at path-index `j` is reachable iff every gate from the active
  // slot up to (but not including) `j` passes. `firstInvalidIndex`
  // returns the first failing slot from `fallbackIndex`; every slot up
  // to and including that index is reachable (the user can always step
  // onto the gate that's currently blocking them). Slots already at or
  // behind the active slot are always reachable. On edit the hydrated
  // payload validates every gate, so the ceiling is the whole path.
  const reachableUntil = useMemo(
    () =>
      Math.max(
        fallbackIndex,
        firstInvalidIndex(payload, stepList, fallbackIndex),
      ),
    [payload, stepList, fallbackIndex],
  );
  // Jump-to-last is enabled only when the WHOLE path validates — i.e.
  // every step from the first slot onward passes its gate, so a single
  // tap can land the user on the review step without stranding them
  // behind an unmet requirement.
  const lastReachable = firstInvalidIndex(payload, stepList, 0) >= totalSteps;

  const canContinue = useMemo(
    () => validateStep(payload, step),
    [payload, step],
  );

  const goNext = useCallback(() => {
    if (!canContinue) return;
    const list = progressIndices(payload.mode, payload.cadence.kind);
    // Step the user forward to the next path step that's strictly
    // greater than the current step. If the current step is on the
    // path, that's just the slot after it; if it's off-path (Step 5
    // after picking "Einmalig"), we still land on the first higher
    // step in the path, which is the one-shot summary at step 8.
    const forward = list.find((n) => n > step);
    if (forward !== undefined) {
      // Crossing into Step 8 commits the active per-schedule draft so
      // the schedule-list view renders the user's just-edited cadence
      // and times. Step transitions inside Steps 5-7 keep the flat
      // mirror as the source of truth.
      if (forward === 8) {
        setPayload((prev) => commitActiveDraft(prev));
      }
      setStep(forward as StepNumber);
    }
  }, [canContinue, payload.mode, payload.cadence.kind, step]);

  const goBack = useCallback(() => {
    const list = progressIndices(payload.mode, payload.cadence.kind);
    const backward = [...list].reverse().find((n) => n < step);
    if (backward !== undefined) {
      setStep(backward as StepNumber);
    }
  }, [payload.mode, payload.cadence.kind, step]);

  // v1.8.6 W4b — jump-to-arbitrary-step from the dot stepper. Backward
  // jumps are always allowed; a forward jump is gated on EVERY
  // intervening path gate validating (a multi-step lookahead over the
  // single-step `validateStep`). A jump that lands on the final review
  // step replicates the `goNext` Step-8 commit so the schedule-list view
  // renders the just-edited cadence + times. On edit the payload is
  // pre-hydrated so every gate passes → all dots reachable and
  // jump-to-last is one tap.
  const goToStep = useCallback(
    (target: number) => {
      const list = progressIndices(payload.mode, payload.cadence.kind);
      const j = list.indexOf(target);
      // `fallbackIndex` mirrors the active dot the stepper renders, so
      // the jump gate and the visual reachability never drift.
      const from = fallbackIndex;
      if (j < 0 || j === from) return;
      if (j > from && firstInvalidIndex(payload, list, from) < j) return;
      if (target === 8) {
        setPayload((prev) => commitActiveDraft(prev));
      }
      setStep(target as StepNumber);
    },
    [payload, fallbackIndex],
  );

  // Focus the first interactive control on each step change. The
  // initial render skips so opening the dialog does not steal focus
  // from the trigger button — UNLESS the dialog opened on a non-Step-1
  // landing (an intent-routed edit, e.g. cadence row → Step 5). In
  // that case the title is the right focus target so the screen reader
  // announces the step the user actually landed on, not the first
  // input on it. The two branches are mutually exclusive so the user
  // gets exactly one focus shift per step transition.
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      if (mode === "edit" && step !== 1) {
        stepTitleRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    const node = bodyRef.current;
    if (!node) return;
    const target = node.querySelector<HTMLElement>(
      'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    target?.focus({ preventScroll: true });
  }, [mode, step]);

  /**
   * Step 8 actions — every schedule-list mutation routes through the
   * pure helpers so the flat mirror stays in sync.
   */
  const onEditSchedule = useCallback((index: number) => {
    setPayload((prev) => setActiveSchedule(prev, index));
    setStep(5);
  }, []);

  const onRemoveSchedule = useCallback((index: number) => {
    setPayload((prev) => removeSchedule(prev, index));
  }, []);

  const onAddSchedule = useCallback(() => {
    setPayload((prev) => addSchedule(prev));
    setStep(5);
  }, []);

  const stepCaption =
    payload.schedules.length > 1 && step >= 5 && step <= 7
      ? t("medications.wizard.compose.scheduleIndex", {
          n: payload.activeScheduleIndex + 1,
          total: payload.schedules.length,
        })
      : null;

  const onSubmit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = buildCreateBody(payload, mode);
      const url =
        mode === "edit" && initial
          ? `/api/medications/${initial.id}`
          : "/api/medications";
      const method = mode === "edit" ? "PUT" : "POST";

      const res = await apiFetchRaw(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        data?: { id: string };
        error?: string;
      };
      const successStatus = mode === "edit" ? 200 : 201;
      if (res.status === successStatus && json.data?.id) {
        await invalidateKeys(queryClient, medicationDependentKeys);
        toast.success(t("common.saved"));
        onSuccess?.(json.data.id);
        onOpenChange(false);
        if (mode === "create") {
          router.push(`/medications/${json.data.id}`);
        }
        return;
      }
      setSubmitError(json.error ?? t("medications.wizard.errors.submitFailed"));
    } catch {
      setSubmitError(t("medications.wizard.errors.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [initial, mode, onOpenChange, onSuccess, payload, queryClient, router, t]);

  const Icon = STEP_ICONS[step];

  const headerTitle =
    mode === "edit" && initial
      ? t("medications.wizard.header.editTitle", { name: initial.name })
      : t("medications.wizard.header.createTitle");

  const stepTitle = t(`medications.wizard.steps.step${step}.title`);
  const stepSubline = t(`medications.wizard.steps.step${step}.subline`);
  const stepOf = t("medications.wizard.header.stepOf", {
    current: displayStep,
    total: totalSteps,
  });

  // v1.8.6 W4b — short per-slot labels for the dot stepper. Keyed by
  // raw step number so the path-aware `stepList` maps straight through.
  const stepperLabels = useMemo(() => {
    const map: Record<number, string> = {};
    for (const n of stepList) {
      map[n] = t(`medications.wizard.steps.step${n}.short`);
    }
    return map;
  }, [stepList, t]);

  // "What's next" hint under the step title. On the final slot the
  // hint flips to the save target; otherwise it names the next slot's
  // short label.
  const nextSlot = stepList[fallbackIndex + 1];
  const nextHint = isLastStep
    ? t("medications.wizard.nav.reviewHint")
    : t("medications.wizard.nav.nextHint", {
        step: t(`medications.wizard.steps.step${nextSlot}.short`),
      });

  const primaryCtaLabel = isLastStep
    ? mode === "edit"
      ? t("medications.wizard.nav.saveEdit")
      : t("medications.wizard.nav.save")
    : t("medications.wizard.nav.next");

  return (
    <>
      <ResponsiveSheet
        open={open}
        onOpenChange={onOpenChange}
        title={headerTitle}
        hideHeader
        showCloseButton
        // v1.6.0 — the unified editor widens to the 2xl ceiling on
        // desktop so the sectioned form (Identity / Plan / Reminders /
        // Specific) reads comfortably without the cramped 560 px
        // column the v1.5 wizard used. The mobile bottom-sheet keeps
        // the `40dvh` floor so the sheet never collapses to a stub on
        // short screens.
        contentWidth="2xl"
        className="min-h-[40dvh] md:min-h-0"
        bodyClassName="gap-0 p-0"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={isFirstStep || submitting}
              data-slot="wizard-back"
              className="h-11"
            >
              {t("medications.wizard.nav.back")}
            </Button>
            {!isLastStep ? (
              <Button
                type="button"
                onClick={goNext}
                disabled={!canContinue}
                data-slot="wizard-next"
                className="h-11"
              >
                {primaryCtaLabel}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => void onSubmit()}
                disabled={!canContinue || submitting}
                data-slot="wizard-save"
                aria-busy={submitting || undefined}
                className="h-11"
              >
                {submitting && (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                )}
                {primaryCtaLabel}
              </Button>
            )}
          </div>
        }
      >
        <div
          data-slot="medication-wizard-dialog"
          data-step={step}
          data-display-step={displayStep}
          data-total-steps={totalSteps}
          data-mode={mode}
          aria-busy={submitting || undefined}
          className="flex flex-col"
        >
          {/* v1.8.6 W4b — dot stepper replaces the v1.5.5 continuous
              `<Progress>` strip + "Step X of Y" caption. The dot row +
              body share the same outer padding so they read as one
              column; the right padding leaves room for the shell's
              36 px close-X (`pr-12` mobile / `pr-14` desktop). The NL
              "Describe" affordance is re-homed beside the stepper on
              the Step-1 create path. */}
          <div className="border-border/70 space-y-1.5 border-b p-4 pr-12 sm:p-6 sm:pr-14">
            <WizardStepper
              steps={stepList}
              current={step}
              reachableUntil={reachableUntil}
              labels={stepperLabels}
              onJump={goToStep}
              onFirst={() => goToStep(stepList[0])}
              onLast={() => goToStep(stepList[totalSteps - 1])}
              firstEnabled={!isFirstStep}
              lastEnabled={lastReachable && !isLastStep}
              firstLabel={t("medications.wizard.nav.jumpFirst")}
              lastLabel={t("medications.wizard.nav.jumpLast")}
              srLabel={stepOf}
            />
            {step === 1 && mode === "create" && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1 px-2 text-xs"
                  onClick={() => setNlOpen(true)}
                  data-slot="wizard-nl-button"
                  aria-label={t("medications.wizard.nl.button")}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("medications.wizard.nl.button")}
                </Button>
              </div>
            )}
          </div>

          {/* Step body — v1.5.5 D-3 §8 spacing buckets:
              outer  = p-4 pr-12 sm:p-6 sm:pr-14
              section = gap-6 sm:gap-8
              row    = gap-3
              tight  = space-y-1
              The fade-only `animate-in fade-in-0` transition is the
              one motion vocabulary on a step change; `motion-reduce`
              snaps the step. The slide proposed in D-2 was stripped. */}
          <div
            ref={bodyRef}
            className="animate-in fade-in-0 flex flex-col gap-6 p-4 pr-12 duration-200 motion-reduce:animate-none sm:gap-8 sm:p-6 sm:pr-14"
            data-slot="wizard-step-body"
            key={step}
          >
            <div className="flex items-start gap-3">
              <div
                className="bg-card border-border/60 grid h-10 w-10 shrink-0 place-items-center rounded-xl border"
                data-slot="wizard-step-icon"
                aria-hidden="true"
              >
                <Icon className="text-primary h-6 w-6" />
              </div>
              <div className="min-w-0 space-y-1">
                {stepCaption && (
                  <p
                    className="text-muted-foreground text-xs"
                    data-slot="wizard-schedule-caption"
                  >
                    {stepCaption}
                  </p>
                )}
                {/* v1.5.5 D-3 §8 + H-cluster-B — `tabIndex={-1}`
                    heading so an intent-routed edit-open (cadence row
                    → Step 5) can drop focus on the title first. The
                    `text-base font-semibold` keeps the title at the
                    same scale as every other section header in the
                    app (the D-2 `text-lg` outlier is dropped). */}
                <h2
                  ref={stepTitleRef}
                  tabIndex={-1}
                  className="text-foreground text-base leading-tight font-semibold tracking-tight focus-visible:outline-none"
                >
                  {stepTitle}
                </h2>
                <p className="text-muted-foreground text-sm">{stepSubline}</p>
                {/* v1.8.6 W4b — muted "what's next" hint so the user
                    knows what the Next tap leads to (or, on the final
                    slot, that Next saves). */}
                <p
                  className="text-muted-foreground flex items-center gap-0.5 pt-0.5 text-xs"
                  data-slot="wizard-next-hint"
                >
                  <ChevronRight
                    className="h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                  {nextHint}
                </p>
              </div>
            </div>

            <div data-slot="wizard-step-field">
              {step === 1 && (
                <Step1Name payload={payload} applyPartial={applyPartial} />
              )}
              {step === 2 && (
                <Step2Class payload={payload} applyPartial={applyPartial} />
              )}
              {step === 3 && (
                <Step3Dose payload={payload} applyPartial={applyPartial} />
              )}
              {step === 4 && (
                <Step4Window payload={payload} applyPartial={applyPartial} />
              )}
              {step === 5 && (
                <Step5Cadence payload={payload} applyPartial={applyPartial} />
              )}
              {step === 6 && (
                <Step6SubCadence
                  payload={payload}
                  applyPartial={applyPartial}
                />
              )}
              {step === 7 && (
                <Step7Times payload={payload} applyPartial={applyPartial} />
              )}
              {step === 8 && (
                <Step8Summary
                  payload={payload}
                  applyPartial={applyPartial}
                  mode={mode}
                  initial={initial}
                  submitError={submitError}
                  onEditSchedule={onEditSchedule}
                  onRemoveSchedule={onRemoveSchedule}
                  onAddSchedule={onAddSchedule}
                />
              )}
            </div>
          </div>
        </div>
      </ResponsiveSheet>
      {/* Natural-language extractor — same dialog the v1.5.3 page mounted.
          Only available on the create path; edit flows already know
          what the medication looks like. */}
      {mode === "create" && (
        <NaturalLanguageExtractor
          open={nlOpen}
          onClose={() => setNlOpen(false)}
          onPrefill={(partial) => {
            applyPartial(extractorToWizardPartial(partial));
          }}
          locale={locale}
        />
      )}
    </>
  );
}
