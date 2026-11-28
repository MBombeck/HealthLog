import { FinishLaterButton } from "@/components/onboarding/finish-later-button";
import { SetupFrame } from "@/components/onboarding/setup-frame";
import { screenHref } from "@/components/onboarding/screen-href";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import {
  previousScreen,
  stepperPosition,
  type FlowState,
  type OnboardingScreenId,
} from "@/lib/onboarding/wizard-steps";

/**
 * The chrome around every person setup screen (1.50): the focus frame with
 * the stepper read off the flow's pinned segments, Back to the previous
 * screen, and "Finish later" from the second screen on (the first one
 * carries the disclaimer, which has to be answered before anything else).
 *
 * Server component: nothing here holds state. Each screen owns its action
 * row (`StepActions`), because what "Continue" persists differs per screen.
 */
export async function OnboardingShell({
  screen,
  state,
  userLocale,
  children,
}: {
  screen: OnboardingScreenId;
  state: FlowState;
  userLocale: string | null;
  children: React.ReactNode;
}) {
  const locale = await resolveServerLocale({ userLocale });
  const { t } = getServerTranslator(locale);
  const position = stepperPosition(state, screen);
  const previous = previousScreen(state, screen);

  return (
    <SetupFrame
      screen={screen}
      stepper={{
        steps: position.segments.map((id) => ({
          id,
          label: t(`setup.person.segments.${id}`),
        })),
        current: position.current,
        fraction: position.fraction,
        countLabel: t("onboarding.shell.stepOf", {
          current: position.current + 1,
          total: position.segments.length,
        }),
      }}
      back={
        previous
          ? { href: screenHref(previous), label: t("onboarding.shell.back") }
          : undefined
      }
      later={screen === "who" ? undefined : <FinishLaterButton flow="person" />}
    >
      {children}
    </SetupFrame>
  );
}
