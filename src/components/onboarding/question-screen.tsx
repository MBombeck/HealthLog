"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  Brain,
  CalendarHeart,
  Droplets,
  FlaskConical,
  HeartPulse,
  Moon,
  Scale,
  Thermometer,
  type LucideIcon,
} from "lucide-react";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import {
  hasEnteredOnboardingFlow,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import {
  QUESTIONS,
  questionAnswerBody,
  questionOptionLabelKey,
  questionPrefill,
  questionSkipBody,
  type QuestionStepId,
} from "@/lib/onboarding/question-config";
import { nextScreen, previousScreen } from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 (C2) — one question per screen, Q1 to Q5.
 *
 * The chip set is the whole screen (design spec §Principles 3: one screen,
 * one decision). The selection lives in component state while the screen is
 * open, pre-filled from the stored answers so a returning person sees what
 * they said; "Next" persists it through the answers route and navigates from
 * the state the server hands back, so "where next" is the step machine's
 * reading of the ledger the server wrote, not this screen's guess.
 *
 * Q1 is required and has no skip; every other question may be passed, and a
 * pass records the pass without touching the stored answer.
 */
const AREA_ICONS: Readonly<Record<string, LucideIcon>> = {
  "blood-pressure": HeartPulse,
  "weight-body": Scale,
  glucose: Droplets,
  sleep: Moon,
  mood: Brain,
  cycle: CalendarHeart,
  activity: Activity,
  labs: FlaskConical,
  illness: Thermometer,
};

/** Answers that carry a second line under the label. */
const OPTION_HINTS: Readonly<Record<string, string>> = {
  "who.someone-else": "onboarding.flow.who.hints.someone-else",
  "who.both": "onboarding.flow.who.hints.both",
  "sources.apple-health": "onboarding.flow.sources.hints.apple-health",
  "sources.file": "onboarding.flow.sources.hints.file",
};

export function QuestionScreen({
  step,
  state,
}: {
  step: QuestionStepId;
  state: OnboardingStateDto;
}) {
  const { t } = useTranslations();
  const router = useRouter();
  const question = QUESTIONS[step];
  const answer = useOnboardingAnswer();

  const [selected, setSelected] = useState<string[]>(() =>
    questionPrefill(step, state.needs),
  );

  const choose = (value: string) => {
    setSelected((prev) => {
      if (question.kind === "single") return [value];
      return prev.includes(value)
        ? prev.filter((v) => v !== value)
        : [...prev, value];
    });
  };

  const body = questionAnswerBody(step, selected);
  // Back from Q1 leads to the welcome screen only while the flow has not
  // been entered: once Q1 is answered the front door resumes at the step
  // owed, so a Back link there would bounce straight back here.
  const previous = previousScreen(state, step);
  const back =
    previous === "welcome" && hasEnteredOnboardingFlow(state) ? null : previous;

  async function persist(input: NonNullable<typeof body>) {
    try {
      const written = await answer.mutateAsync(input);
      router.push(screenHref(nextScreen(written, step) ?? "confirm"));
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    }
  }

  const titleId = `onboarding-${step}-title`;

  return (
    <section aria-labelledby={titleId} className="space-y-6">
      <StepHeading
        id={titleId}
        title={t(`onboarding.flow.${step}.title`)}
        description={t(`onboarding.flow.${step}.body`)}
      />

      <fieldset
        className={
          step === "areas"
            ? "grid grid-cols-1 gap-3 sm:grid-cols-2"
            : "grid grid-cols-1 gap-3"
        }
        data-slot={`onboarding-question-${step}`}
      >
        <legend className="sr-only">
          {t(`onboarding.flow.${step}.title`)}
        </legend>
        {question.options.map((option) => {
          const hintKey = OPTION_HINTS[`${step}.${option}`];
          return (
            <ChoiceChip
              key={option}
              name={`onboarding-${step}`}
              value={option}
              kind={question.kind}
              checked={selected.includes(option)}
              onChange={choose}
              label={t(questionOptionLabelKey(step, option))}
              hint={hintKey ? t(hintKey) : undefined}
              Icon={step === "areas" ? AREA_ICONS[option] : undefined}
            />
          );
        })}
      </fieldset>

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={
          question.skippable
            ? () =>
                void persist(
                  questionSkipBody(step as Exclude<QuestionStepId, "who">),
                )
            : undefined
        }
        onNext={() => {
          if (body) void persist(body);
        }}
        nextDisabled={body === null}
        pending={answer.isPending}
      />
    </section>
  );
}
