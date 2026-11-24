import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";

/**
 * The frame both setup flows paint: the logo, the step counter, the step
 * track and the one `<main>`. The person flow (`OnboardingShell`) and the
 * server setup (1.49) hand it their own steps, already translated, so the two
 * cannot drift apart in layout.
 */
export function SetupFrame({
  screen,
  flow = "person",
  counter,
  stepsLabel,
  steps,
  children,
}: {
  screen: string;
  flow?: "person" | "server";
  counter: string | null;
  stepsLabel: string;
  steps: ReadonlyArray<{ id: string; label: string }>;
  children: React.ReactNode;
}) {
  const currentIndex = steps.findIndex((step) => step.id === screen);

  return (
    <div
      className={cn(
        "mx-auto flex min-h-[100svh] w-full max-w-xl flex-col",
        // Safe-area-respecting bottom padding for the iOS PWA — the home
        // bar overlaps the primary action otherwise.
        "px-4 pt-6 pb-[max(var(--safe-area-bottom),1rem)]",
      )}
      data-slot="onboarding-shell"
      data-flow={flow}
      data-screen={screen}
    >
      <header className="mb-6 flex items-center justify-between gap-3">
        <Logo size={32} />
        <p
          className="text-muted-foreground text-sm font-medium"
          aria-live="polite"
          data-slot="onboarding-step-counter"
        >
          {counter}
        </p>
      </header>

      {/* A landmark of its own: every piece of page content sits inside one
          (axe `region`), and the step list is the flow's navigation. */}
      <nav aria-label={stepsLabel} className="mb-8">
        <ol
          className="flex items-center gap-2"
          data-slot="onboarding-step-list"
        >
          {steps.map((step, index) => {
            const reached = currentIndex >= index;
            return (
              <li
                key={step.id}
                aria-current={step.id === screen ? "step" : undefined}
                data-reached={reached}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  reached ? "bg-primary" : "bg-muted",
                )}
              >
                <span className="sr-only">{step.label}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* The page's one `<main>`: the auth shell's onboarding branch renders
          no landmark of its own around this frame. */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
