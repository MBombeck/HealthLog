"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { showErrorToast } from "@/lib/errors/error-toast";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import { TimezonePicker } from "@/components/settings/timezone-picker";
import { useMedicineRegistryOptions } from "@/components/settings/use-medicine-registry-options";
import { FieldGroup } from "@/components/ui/field-group";
import { InlineAction } from "@/components/ui/inline-action";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import {
  unitQuestionsFor,
  unitsAnswerBody,
} from "@/lib/onboarding/question-config";
import { nextScreen, previousScreen } from "@/lib/onboarding/wizard-steps";
import type { MedicineRegistryChoice } from "@/lib/medications/leaflet-registries";
import { storeTimezone } from "@/lib/timezone-mirror";
import { DEFAULT_TIMEZONE, detectBrowserTimezone } from "@/lib/tz/format";

type GlucoseUnit = "mg/dL" | "mmol/L";
type UnitPreference = "metric" | "imperial";

/**
 * v1.39 — Q6, the optional units question; "Region & units" since 1.49, with
 * the time zone and, when medication was chosen, the medicine registry.
 *
 * The time zone and the registry arrive filled with what the account already
 * holds (the zone detected at sign-up, the registry derived from language and
 * zone), so "Continue" confirms them; the device's zone is offered beside a
 * stored one that differs.
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

  const [timezone, setTimezone] = useState<string>(
    () => state.needs.units.timezone ?? user?.timezone ?? DEFAULT_TIMEZONE,
  );
  const [medicineRegistry, setMedicineRegistry] =
    useState<MedicineRegistryChoice>(
      () =>
        state.needs.units.medicineRegistry ?? user?.medicineRegistry ?? "NONE",
    );
  const registryOptions = useMedicineRegistryOptions();
  // The device zone is read after hydration so both renders agree.
  const mounted = useMounted();
  const deviceZone = mounted ? detectBrowserTimezone() : "";

  const back = previousScreen(state, "units");

  const answerBody = unitsAnswerBody({
    asked,
    glucoseUnit,
    unitPreference,
    timezone,
    medicineRegistry,
  });

  async function persist(
    input:
      | NonNullable<ReturnType<typeof unitsAnswerBody>>
      | {
          step: "units";
          status: "skipped";
        },
  ) {
    try {
      const written = await answer.mutateAsync(input);
      // The browser's own zone mirror follows the saved answer, as it does
      // for Settings.
      const zone = "units" in input ? input.units.timezone : undefined;
      if (zone) storeTimezone(zone);
      router.push(screenHref(nextScreen(written, "units") ?? "confirm"));
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
        cause: err,
      });
    }
  }

  return (
    <section aria-labelledby="onboarding-units-title" className="space-y-6">
      <StepHeading
        id="onboarding-units-title"
        title={t("onboarding.flow.units.title")}
        description={t("onboarding.flow.units.body")}
      />

      <div className="space-y-1" data-slot="onboarding-question-timezone">
        <TimezonePicker
          id="onboarding-timezone"
          value={timezone}
          onChange={setTimezone}
          hint={t("onboarding.flow.units.timezoneHint")}
        />
        {deviceZone && deviceZone !== timezone ? (
          <InlineAction
            tone="primary"
            size="xs"
            data-slot="onboarding-timezone-use-device"
            onClick={() => setTimezone(deviceZone)}
          >
            {t("settings.timezoneUseDevice", { zone: deviceZone })}
          </InlineAction>
        ) : null}
      </div>

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

      {asked.registry ? (
        <div data-slot="onboarding-question-medicine-registry">
          <FieldGroup
            htmlFor="onboarding-medicine-registry"
            label={t("onboarding.flow.units.registryLegend")}
            hint={t("settings.sections.medications.registry.privacy")}
          >
            <NativeSelect
              id="onboarding-medicine-registry"
              value={medicineRegistry}
              onChange={(e) =>
                setMedicineRegistry(e.target.value as MedicineRegistryChoice)
              }
            >
              <option value="NONE">
                {t("settings.sections.medications.registry.none")}
              </option>
              {registryOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </FieldGroup>
        </div>
      ) : null}

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={() => void persist({ step: "units", status: "skipped" })}
        onNext={() => {
          if (answerBody) void persist(answerBody);
        }}
        nextDisabled={answerBody === null}
        pending={answer.isPending}
      />
    </section>
  );
}
