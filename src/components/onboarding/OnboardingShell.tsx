import Link from "next/link";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { Button } from "@/components/ui/button";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

/**
 * v1.4.25 W14b — onboarding wizard chrome.
 *
 * Renders the shared frame around every step in the rebuilt
 * `/onboarding/[step]` flow: logo, "Step N of 4" label, four-dot
 * progress strip, the step body slot, and the back / skip / next
 * action row pinned to the bottom safe-area.
 *
 * Step encoding (mirrors `User.onboardingStep`):
 *   0 = welcome  (no progress dot; intro screen, primary action is "next")
 *   1 = goals    (dot 1 active)
 *   2 = source   (dot 2 active)
 *   3 = baseline (dot 3 active)
 *   4 = done     (dot 4 active; "done" copy; primary CTA = return to dashboard)
 *
 * Server component — every step page is also a server component and
 * the shell carries no client state. Back / skip / next are plain
 * `<Link>`s wrapping `<Button>`s; the W14b-Content agent will replace
 * those with form submissions / mutations on the step pages that need
 * them, while the chrome itself stays static.
 *
 * Locale resolution mirrors the rest of the server tree
 * (`resolveServerLocale` → cookie → User.locale → Accept-Language).
 */

export interface OnboardingShellProps {
  /** 0..4 — see step encoding above. Out-of-range values clamp to 0. */
  step: number;
  /**
   * Step body slot. Step pages render their step-specific UI here; the
   * shell handles every surrounding pixel.
   */
  children: React.ReactNode;
  /** Href for the back button. Hidden when undefined (e.g. step 0). */
  backHref?: string;
  /** Href for the "Skip" link. Hidden when undefined. */
  skipHref?: string;
  /** Href for the primary forward CTA. Hidden when undefined. */
  nextHref?: string;
  /**
   * Override the primary CTA label. Defaults to `onboarding.shell.next`
   * (or `onboarding.shell.done.returnCta` at step 4).
   */
  nextLabel?: string;
  /** Override the userLocale used for translator resolution (test hook). */
  userLocale?: string | null;
  className?: string;
}

const TOTAL_STEPS = 4;

export async function OnboardingShell({
  step,
  children,
  backHref,
  skipHref,
  nextHref,
  nextLabel,
  userLocale,
  className,
}: OnboardingShellProps) {
  const clamped = clampStep(step);
  const locale = await resolveServerLocale({ userLocale: userLocale ?? null });
  const { t } = getServerTranslator(locale);

  // Progress label only appears for the four real steps; the welcome
  // intro (step 0) and the done screen (step 4) both reuse the
  // ordinal keys (1/4 and 4/4 respectively) so the strip never goes
  // blank between transitions.
  const progressLabel =
    clamped === 0
      ? t("onboarding.shell.step1of4")
      : t(`onboarding.shell.step${clamped}of4`);

  const primaryLabel =
    nextLabel ?? (clamped === 4 ? t("onboarding.done.returnCta") : t("onboarding.shell.next"));

  return (
    <div
      className={cn(
        "mx-auto flex min-h-[100svh] w-full max-w-xl flex-col",
        // Safe-area-respecting bottom padding for iOS PWA standalone.
        // Mirrors the pattern called out in the W14b research file
        // (Section 4.4) — the home-bar overlaps the primary CTA
        // otherwise.
        "px-4 pt-6 pb-[max(env(safe-area-inset-bottom),1rem)]",
        className,
      )}
    >
      <header className="mb-6 flex items-center justify-between gap-3">
        <Logo size={32} />
        <p
          className="text-muted-foreground text-sm font-medium"
          aria-live="polite"
        >
          {progressLabel}
        </p>
      </header>

      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={TOTAL_STEPS}
        aria-valuenow={clamped === 0 ? 1 : clamped}
        aria-label={progressLabel}
        className="mb-8 flex items-center gap-2"
      >
        {Array.from({ length: TOTAL_STEPS }, (_, i) => {
          const dotStep = i + 1;
          const active = clamped >= dotStep || (clamped === 0 && dotStep === 1);
          return (
            <span
              key={dotStep}
              data-active={active}
              aria-current={
                (clamped === 0 ? 1 : clamped) === dotStep ? "step" : undefined
              }
              className={cn(
                "h-1.5 flex-1 rounded-full transition-colors",
                active ? "bg-primary" : "bg-muted",
              )}
            />
          );
        })}
      </div>

      <main className="flex-1">{children}</main>

      <footer className="mt-8 flex items-center justify-between gap-2">
        {backHref ? (
          <Button asChild variant="ghost" className="min-h-11 min-w-11">
            <Link href={backHref}>{t("onboarding.shell.back")}</Link>
          </Button>
        ) : (
          <span aria-hidden="true" />
        )}

        <div className="flex items-center gap-2">
          {skipHref ? (
            <Button asChild variant="ghost" className="min-h-11 min-w-11">
              <Link href={skipHref}>{t("onboarding.shell.skip")}</Link>
            </Button>
          ) : null}
          {nextHref ? (
            <Button asChild className="min-h-11 min-w-11">
              <Link href={nextHref}>{primaryLabel}</Link>
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function clampStep(step: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(step)) return 0;
  const rounded = Math.floor(step);
  if (rounded < 0) return 0;
  if (rounded > 4) return 4;
  return rounded as 0 | 1 | 2 | 3 | 4;
}
