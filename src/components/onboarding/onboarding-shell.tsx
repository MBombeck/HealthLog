import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type {
  OnboardingStateDto,
  OnboardingStepId,
} from "@/lib/onboarding/needs";
import {
  screenOrder,
  stepCounter,
  type OnboardingScreenId,
} from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 (C2) — the chrome around every setup screen.
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
export interface OnboardingShellProps {
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

  const counter = stepCounter(state, screen);
  const steps = screenOrder(state).filter(
    (id): id is OnboardingStepId => id !== "welcome",
  );
  const currentIndex = (steps as readonly string[]).indexOf(screen);

  return (
    <div
      className={cn(
        "mx-auto flex min-h-[100svh] w-full max-w-xl flex-col",
        // Safe-area-respecting bottom padding for the iOS PWA — the home
        // bar overlaps the primary action otherwise.
        "px-4 pt-6 pb-[max(env(safe-area-inset-bottom),1rem)]",
      )}
      data-slot="onboarding-shell"
      data-screen={screen}
    >
      <header className="mb-6 flex items-center justify-between gap-3">
        <Logo size={32} />
        <p
          className="text-muted-foreground text-sm font-medium"
          aria-live="polite"
          data-slot="onboarding-step-counter"
        >
          {counter
            ? t("onboarding.shell.stepOf", {
                current: counter.current,
                total: counter.total,
              })
            : null}
        </p>
      </header>

      <ol
        aria-label={t("onboarding.shell.stepsLabel")}
        className="mb-8 flex items-center gap-2"
        data-slot="onboarding-step-list"
      >
        {steps.map((id, index) => {
          const reached = currentIndex >= index;
          return (
            <li
              key={id}
              aria-current={id === screen ? "step" : undefined}
              data-reached={reached}
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                reached ? "bg-primary" : "bg-muted",
              )}
            >
              <span className="sr-only">{t(`onboarding.steps.${id}`)}</span>
            </li>
          );
        })}
      </ol>

      <main className="flex-1">{children}</main>
    </div>
  );
}
