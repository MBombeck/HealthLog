"use client";

/**
 * v1.5.4 — Modal medication-creation wizard.
 *
 * Replaces the v1.5.3 `<CreationWizard>` card with a popup that lives
 * inside `<ResponsiveSheet>` (centred dialog on `md+`, bottom sheet on
 * narrow viewports). The sheet's title row carries the close button;
 * under it the progress band shows four fixed phases (Medication, Dose,
 * Schedule, Review, `./wizard-phases.ts`). The body holds the step's
 * heading, one sentence and its field, and a sticky footer Back / Next
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
import { useAiCapability } from "@/hooks/use-ai-capability";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { InlineAction } from "@/components/ui/inline-action";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Stepper } from "@/components/ui/stepper";
import { useDisplayTimezone, useTranslations } from "@/lib/i18n/context";
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
import {
  MEDICATION_PHASES,
  PHASE_LANDING_STEP,
  phaseForStep,
} from "./wizard-phases";
import { Step1Name } from "./steps/step1-name";
import { Step2Class } from "./steps/step2-class";
import { Step3Dose } from "./steps/step3-dose";
import { Step4Window } from "./steps/step4-window";
import { Step5Cadence } from "./steps/step5-cadence";
import { Step6SubCadence } from "./steps/step6-sub-cadence";
import { Step7Times } from "./steps/step7-times";
import { Step8Summary } from "./steps/step8-summary";
import { stepBlocker } from "./wizard-payload";
import { extractorToWizardPartial } from "./nl-bridge";

export interface MedicationWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Required when `mode === "edit"`. */
  initial?: MedicationPayload;
  /** Fires with the medication id on a successful create / save. */
  onSuccess?: (id: string) => void;
  /**
   * v1.39 — whether a create lands on the new medication's page. The
   * medications list wants that; the setup flow's first-result screen mounts
   * the wizard inline and shows the result where it stands, so it opts out.
   */
  navigateOnCreate?: boolean;
}

type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Steps whose heading carries a sentence under it. The cadence, its details
 * and the review say what they ask in the heading and the choices alone.
 */
const STEPS_WITH_SUBLINE: ReadonlySet<number> = new Set([1, 2, 3, 4, 7]);

/**
 * Whether closing would lose input: what a save would send now against what
 * it would have sent on opening. Moving between steps or schedules is not
 * input.
 */
function wizardHasInput(
  seed: WizardPayload,
  payload: WizardPayload,
  mode: MedicationWizardDialogProps["mode"],
): boolean {
  try {
    return (
      JSON.stringify(buildCreateBody(payload, mode)) !==
      JSON.stringify(buildCreateBody(seed, mode))
    );
  } catch {
    return true;
  }
}

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
  navigateOnCreate = true,
}: MedicationWizardDialogProps) {
  const { t, locale } = useTranslations();
  // The "describe it in words" reader follows the `medicationExtract`
  // capability: offered while available or while only the reading consent is
  // missing (the sheet asks for it); otherwise the manual steps are all.
  const medicationExtract = useAiCapability("medicationExtract");
  const extractOffered =
    medicationExtract.available ||
    medicationExtract.reason === "consent_required";
  const router = useRouter();
  const queryClient = useQueryClient();

  const userTz = useDisplayTimezone();
  const [seed] = useState<WizardPayload>(() =>
    mode === "edit" && initial
      ? hydrateWizardPayload(initial, userTz)
      : emptyWizardPayload(userTz),
  );
  const [payload, setPayload] = useState<WizardPayload>(seed);
  const [step, setStep] = useState<StepNumber>(() =>
    mode === "edit" && initial ? (landingStepForEdit(seed) as StepNumber) : 1,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [nlOpen, setNlOpen] = useState(false);
  // The step heading takes focus on every step change, so a screen reader
  // hears where the person now stands before the field.
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

  // Forward-reachability ceiling over the path. The slot at path-index
  // `j` is reachable iff every gate from the active slot up to (but not
  // including) `j` passes. `firstInvalidIndex`
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

  // The band's four phases. A phase segment is a button when the step it
  // lands on is reachable: behind the current one always, ahead of it when
  // every gate on the way passes. On edit the hydrated payload passes every
  // gate, so a rename is: type, tap Review, Save.
  const { phase, fraction: phaseFraction } = phaseForStep(step);
  const phaseReachableUntil = PHASE_LANDING_STEP.reduce(
    (acc, landing, index) => {
      const j = stepList.indexOf(landing);
      return j >= 0 && j <= reachableUntil ? index : acc;
    },
    phase,
  );

  // What still holds this step, said under the disabled button rather than
  // left for the person to guess; null when the step can be left.
  const blocker = useMemo(() => stepBlocker(payload, step), [payload, step]);
  const canContinue = blocker === null;

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

  // Jump to a raw step, from a phase segment of the band. Backward jumps
  // are always allowed; a forward jump is gated on EVERY intervening path
  // gate validating (a multi-step lookahead over the single-step
  // `validateStep`). A jump that lands on the final review step replicates
  // the `goNext` Step-8 commit so the schedule-list view renders the
  // just-edited cadence + times. On edit the payload is pre-hydrated so
  // every gate passes, and Review is one tap away.
  const goToStep = useCallback(
    (target: number) => {
      const list = progressIndices(payload.mode, payload.cadence.kind);
      const j = list.indexOf(target);
      // `fallbackIndex` is also what `reachableUntil` starts from, so the
      // jump gate and the band's tappable segments never drift.
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

  // The step heading takes focus on each step change, so the new step is
  // announced before its field; Tab reaches the field next. The opening
  // render leaves focus where the sheet put it, except on an edit that
  // lands past step 1 (several schedules open on Review).
  useEffect(() => {
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false;
      if (mode === "edit" && step !== 1) {
        stepTitleRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    stepTitleRef.current?.focus({ preventScroll: true });
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
        if (mode === "create" && navigateOnCreate) {
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
  }, [
    initial,
    mode,
    navigateOnCreate,
    onOpenChange,
    onSuccess,
    payload,
    queryClient,
    router,
    t,
  ]);

  const headerTitle =
    mode === "edit" && initial
      ? t("medications.wizard.header.editTitle", { name: initial.name })
      : t("medications.wizard.header.createTitle");

  const stepTitle = t(`medications.wizard.steps.step${step}.title`);
  // One sentence under the heading only where it adds something the heading
  // and the choices do not say already.
  const stepSubline = STEPS_WITH_SUBLINE.has(step)
    ? t(`medications.wizard.steps.step${step}.subline`)
    : null;
  const phaseCount = t("medications.wizard.header.stepOf", {
    current: phase + 1,
    total: MEDICATION_PHASES.length,
  });
  const phaseSteps = useMemo(
    () =>
      MEDICATION_PHASES.map((id) => ({
        id,
        label: t(`medications.wizard.phase.${id}`),
      })),
    [t],
  );

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
        dirty={() => wizardHasInput(seed, payload, mode)}
        title={headerTitle}
        showCloseButton
        subheader={
          <Stepper
            steps={phaseSteps}
            current={phase}
            fraction={phaseFraction}
            countLabel={phaseCount}
            reachableUntil={phaseReachableUntil}
            onStepSelect={(index) => goToStep(PHASE_LANDING_STEP[index])}
          />
        }
        // v1.6.0 — the unified editor widens to the 2xl ceiling on
        // desktop so the sectioned form (Identity / Plan / Reminders /
        // Specific) reads comfortably without the cramped 560 px
        // column the v1.5 wizard used. The mobile bottom-sheet keeps
        // the `40dvh` floor so the sheet never collapses to a stub on
        // short screens.
        contentWidth="2xl"
        className="min-h-[40dvh] md:min-h-0"
        // `md:pr-3` gives back the dialog body's scrollbar gutter, which
        // `p-0` would otherwise take away from its `-mr-3`.
        bodyClassName="gap-0 p-0 md:pr-3"
        footer={
          <WizardFooter
            blocker={blocker ? t(blocker) : null}
            isFirstStep={isFirstStep}
            isLastStep={isLastStep}
            submitting={submitting}
            label={primaryCtaLabel}
            onBack={goBack}
            onNext={goNext}
            onSubmit={() => void onSubmit()}
          />
        }
      >
        <div
          data-slot="medication-wizard-dialog"
          data-step={step}
          data-display-step={displayStep}
          data-total-steps={totalSteps}
          data-phase={MEDICATION_PHASES[phase]}
          data-phase-index={phase + 1}
          data-phase-count={MEDICATION_PHASES.length}
          data-phase-fraction={phaseFraction}
          data-mode={mode}
          aria-busy={submitting || undefined}
          className="flex flex-col"
        >
          {/* Step body. The sheet's own header (title row and progress band)
              sits above it; this column carries the same inset on both
              sides as the header: `p-4` in the phone sheet, none in the
              dialog, whose frame already pads by 24 px.
              The fade is the one motion on a step change; `motion-reduce`
              snaps the step. */}
          <div
            className="animate-in fade-in-0 flex flex-col gap-6 p-4 duration-200 motion-reduce:animate-none md:gap-8 md:p-0 md:pt-2"
            data-slot="wizard-step-body"
            key={step}
          >
            <div className="min-w-0 space-y-1">
              {stepCaption && (
                <p
                  className="text-muted-foreground text-xs"
                  data-slot="wizard-schedule-caption"
                >
                  {stepCaption}
                </p>
              )}
              <h3
                ref={stepTitleRef}
                tabIndex={-1}
                className="text-foreground text-base leading-tight font-semibold tracking-tight focus-visible:outline-none"
                data-slot="wizard-step-title"
              >
                {stepTitle}
              </h3>
              {stepSubline && (
                <p className="text-muted-foreground text-sm">{stepSubline}</p>
              )}
            </div>

            <div data-slot="wizard-step-field">
              {step === 1 && (
                <Step1Name payload={payload} applyPartial={applyPartial} />
              )}
              {step === 1 && mode === "create" && extractOffered && (
                <InlineAction
                  type="button"
                  tone="primary"
                  size="sm"
                  className="mt-3"
                  onClick={() => setNlOpen(true)}
                  data-slot="wizard-nl-button"
                >
                  <Sparkles aria-hidden="true" />
                  {t("medications.wizard.nl.button")}
                </InlineAction>
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
      {mode === "create" && extractOffered && (
        <NaturalLanguageExtractor
          open={nlOpen}
          onClose={() => setNlOpen(false)}
          onPrefill={(partial) => {
            applyPartial(extractorToWizardPartial(partial));
          }}
          locale={locale}
          consentRequired={medicationExtract.reason === "consent_required"}
        />
      )}
    </>
  );
}

/**
 * Back (Cancel on the first step), then Next or Save. A disabled Next or Save
 * names what still holds the step to a screen reader (`blocker`, from the
 * same gate that disables it); on screen the step's own heading and the
 * disabled button say it already.
 *
 * Cancel stands where Back stands on every later step, in the same style. It
 * closes through the sheet itself (Radix's close, which both the bottom sheet
 * and the dialog are built on), so typed input meets the sheet's shared
 * discard question exactly as the close button and Escape do.
 */
function WizardFooter({
  blocker,
  isFirstStep,
  isLastStep,
  submitting,
  label,
  onBack,
  onNext,
  onSubmit,
}: {
  blocker: string | null;
  isFirstStep: boolean;
  isLastStep: boolean;
  submitting: boolean;
  label: string;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslations();
  const describedBy = blocker ? "wizard-blocked-hint" : undefined;
  return (
    <div className="flex w-full flex-col gap-2">
      {blocker && (
        <p
          id="wizard-blocked-hint"
          className="sr-only"
          data-slot="wizard-blocked-hint"
          aria-live="polite"
        >
          {blocker}
        </p>
      )}
      <div className="flex w-full items-center justify-between gap-2">
        {isFirstStep ? (
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              data-slot="wizard-cancel"
              className="h-11"
            >
              {t("common.cancel")}
            </Button>
          </DialogClose>
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            disabled={submitting}
            data-slot="wizard-back"
            className="h-11"
          >
            {t("medications.wizard.nav.back")}
          </Button>
        )}
        {!isLastStep ? (
          <Button
            type="button"
            onClick={onNext}
            disabled={blocker !== null}
            aria-describedby={describedBy}
            data-slot="wizard-next"
            className="h-11"
          >
            {label}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={onSubmit}
            disabled={blocker !== null || submitting}
            aria-describedby={describedBy}
            data-slot="wizard-save"
            aria-busy={submitting || undefined}
            className="h-11"
          >
            {submitting && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {label}
          </Button>
        )}
      </div>
    </div>
  );
}
