"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import { useAuth } from "@/hooks/use-auth";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import {
  unitQuestionsFor,
  unitsAnswerBody,
} from "@/lib/onboarding/question-config";
import { nextScreen, previousScreen } from "@/lib/onboarding/wizard-steps";

type GlucoseUnit = "mg/dL" | "mmol/L";
type UnitPreference = "metric" | "imperial";

/**
 * v1.39 (C2) — Q6, the optional units question.
 *
 * Shown only while an area that needs a unit is among the answers and the
 * account does not already hold the preference (the step machine decides;
 * this screen is never reached otherwise). Each of the two questions is
 * asked only for the area that needs it, and each is pre-filled from what
 * the flow recorded or, failing that, from the account's own column — so
 * confirming what the account already had sends nothing for that field.
 */
export function UnitsScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const answer = useOnboardingAnswer();
  const asked = unitQuestionsFor(state.needs);

  const [glucoseUnit, setGlucoseUnit] = useState<GlucoseUnit | null>(
    () =>
      state.needs.units.glucoseUnit ??
      (user?.glucoseUnit === "mmol/L" || user?.glucoseUnit === "mg/dL"
        ? user.glucoseUnit
        : null),
  );
  const [unitPreference, setUnitPreference] = useState<UnitPreference | null>(
    () => state.needs.units.unitPreference ?? user?.unitPreference ?? null,
  );

  const back = previousScreen(state, "units");

  async function persist(
    input:
      ReturnType<typeof unitsAnswerBody> | { step: "units"; status: "skipped" },
  ) {
    try {
      const written = await answer.mutateAsync(input);
      router.push(screenHref(nextScreen(written, "units") ?? "confirm"));
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
    }
  }

  return (
    <section aria-labelledby="onboarding-units-title" className="space-y-6">
      <StepHeading
        id="onboarding-units-title"
        title={t("onboarding.flow.units.title")}
        description={t("onboarding.flow.units.body")}
      />

      {asked.glucose ? (
        <fieldset
          className="grid grid-cols-2 gap-3"
          data-slot="onboarding-question-glucose-unit"
        >
          <legend className="text-foreground mb-2 text-sm font-medium">
            {t("onboarding.flow.units.glucoseLegend")}
          </legend>
          {(["mg/dL", "mmol/L"] as const).map((option) => (
            <ChoiceChip
              key={option}
              name="onboarding-glucose-unit"
              value={option}
              kind="single"
              checked={glucoseUnit === option}
              onChange={() => setGlucoseUnit(option)}
              label={option}
            />
          ))}
        </fieldset>
      ) : null}

      {asked.weight ? (
        <fieldset
          className="grid grid-cols-2 gap-3"
          data-slot="onboarding-question-unit-preference"
        >
          <legend className="text-foreground mb-2 text-sm font-medium">
            {t("onboarding.flow.units.weightLegend")}
          </legend>
          {(["metric", "imperial"] as const).map((option) => (
            <ChoiceChip
              key={option}
              name="onboarding-unit-preference"
              value={option}
              kind="single"
              checked={unitPreference === option}
              onChange={() => setUnitPreference(option)}
              label={t(`onboarding.flow.units.options.${option}`)}
            />
          ))}
        </fieldset>
      ) : null}

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={() => void persist({ step: "units", status: "skipped" })}
        onNext={() =>
          void persist(unitsAnswerBody({ asked, glucoseUnit, unitPreference }))
        }
        pending={answer.isPending}
      />
    </section>
  );
}
