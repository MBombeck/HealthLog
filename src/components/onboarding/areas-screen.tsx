"use client";

import { useState } from "react";
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
import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { useTranslations } from "@/lib/i18n/context";
import {
  ONBOARDING_AREA_KEYS,
  type OnboardingAreaKey,
} from "@/lib/modules/registry";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";

/** The glyph of the module each area switches on. */
const AREA_ICONS: Readonly<Record<OnboardingAreaKey, LucideIcon>> = {
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

/**
 * What to keep an eye on: the areas are the module map, so this is the
 * screen that decides which modules are switched on. Any number; "Skip"
 * keeps the defaults.
 */
export function AreasScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const flow = usePersonFlow(state, plan, "areas");
  const [selected, setSelected] = useState<OnboardingAreaKey[]>(
    state.needs.areas,
  );

  function toggle(value: string) {
    const area = value as OnboardingAreaKey;
    setSelected((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area],
    );
  }

  async function persist(skip: boolean) {
    try {
      const written = await flow.record(
        skip
          ? { step: "areas", status: "skipped" }
          : { step: "areas", areas: selected },
      );
      await flow.advance(written);
    } catch (err) {
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-areas-title"
      className="flex flex-1 flex-col"
    >
      <StepHeading
        id="onboarding-areas-title"
        title={t("onboarding.flow.areas.title")}
        description={t("setup.person.areas.body")}
      />
      <fieldset className="grid gap-2" data-slot="onboarding-question-areas">
        <legend className="sr-only">{t("onboarding.flow.areas.title")}</legend>
        {ONBOARDING_AREA_KEYS.map((area) => (
          <ChoiceChip
            key={area}
            name="onboarding-areas"
            value={area}
            kind="multi"
            checked={selected.includes(area)}
            onChange={toggle}
            label={t(`onboarding.flow.areas.options.${area}`)}
            Icon={AREA_ICONS[area]}
          />
        ))}
      </fieldset>
      <StepActions
        secondary={{
          label: t("onboarding.shell.skip"),
          onClick: () => void persist(true),
        }}
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void persist(false),
          disabled: selected.length === 0,
        }}
        pending={flow.pending}
      />
    </section>
  );
}
