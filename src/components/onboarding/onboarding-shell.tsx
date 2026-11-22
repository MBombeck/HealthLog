import { SetupFrame } from "@/components/onboarding/setup-frame";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import {
  stepCounter,
  stepTrack,
  type OnboardingScreenId,
} from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 — the chrome around every setup screen.
 *
 * Logo, the "Step 2 of 6" counter, the step list, and the body slot. The
 * counter and the list are both read off the step machine, so the shell
 * shows exactly the screens THIS flow has — six questions for somebody who
 * ticked glucose, five for somebody who did not, a first-result screen only
 * when there is a task to offer.
 *
 * The step list is a real ordered list (design spec §Principles 6), each
 * entry with its name for a screen reader and `aria-current="step"` on the
 * one in view; the dots are the visual rendering of that list, not a
 * separate progress bar. The counter is `aria-live` so a step change is
 * announced without the heading having to carry the number.
 *
 * Server component: nothing here holds state. Each screen owns its own
 * action row (`StepActions`), because what "next" persists differs per
 * screen and the shell should not know.
 */
interface OnboardingShellProps {
  screen: OnboardingScreenId;
  state: OnboardingStateDto;
  userLocale: string | null;
  children: React.ReactNode;
}

export async function OnboardingShell({
  screen,
  state,
  userLocale,
  children,
}: OnboardingShellProps) {
  const locale = await resolveServerLocale({ userLocale });
  const { t } = getServerTranslator(locale);

  // Counter and bar from the same track, so they always agree.
  const counter = stepCounter(state, screen);
  const steps = stepTrack(state);

  return (
    <SetupFrame
      screen={screen}
      counter={
        counter
          ? t("onboarding.shell.stepOf", {
              current: counter.current,
              total: counter.total,
            })
          : null
      }
      stepsLabel={t("onboarding.shell.stepsLabel")}
      steps={steps.map((id) => ({
        id,
        label: t(`onboarding.steps.${id}`),
      }))}
    >
      {children}
    </SetupFrame>
  );
}
