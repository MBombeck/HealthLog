import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { Logo } from "@/components/ui/logo";
import { Stepper, type StepperStep } from "@/components/ui/stepper";
import { cn } from "@/lib/utils";

/**
 * The focus page every setup step is painted in (1.50): one column, no app
 * chrome, at every width.
 *
 *   top row   Back on the left, "Finish later" on the right; the first
 *             screen of a flow shows the logo there instead
 *   stepper   the shared `Stepper`, one segment per part of the flow
 *   main      the step's heading, body and its action row
 *
 * The step's action row (`StepActions`) sits at the end of `main`: under the
 * content on a wide screen, held at the bottom edge on a phone, where the
 * thumb is. Both the person flow and the server setup use this frame, and so
 * does the owner account screen on `/auth/register`, so a flow that starts
 * anonymously and continues behind a session keeps one shape.
 */
export interface SetupFrameStepper {
  steps: ReadonlyArray<StepperStep>;
  current: number;
  fraction: number;
  countLabel: string;
}

export function SetupFrame({
  screen,
  flow = "person",
  stepper,
  back,
  later,
  className,
  children,
}: {
  screen: string;
  flow?: "person" | "server";
  /** Null on a screen before the flow's steps (the server claim). */
  stepper: SetupFrameStepper | null;
  /** The previous screen; omitted on a flow's first screen. */
  back?: { href: string; label: string };
  /** The "Finish later" control, a client component; omitted where none. */
  later?: ReactNode;
  /** Outer overrides, for the one frame painted inside the auth layout. */
  className?: string;
  children: ReactNode;
}) {
  const showTopRow = Boolean(back || later);
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pt-6 md:pt-16 md:pb-16",
        className,
      )}
      data-slot="onboarding-shell"
      data-flow={flow}
      data-screen={screen}
    >
      <header className="mb-6 flex min-h-11 items-center justify-between gap-3">
        {showTopRow ? (
          <>
            {back ? (
              <Link
                href={back.href}
                data-slot="onboarding-back"
                className="text-foreground hover:bg-accent focus-visible:ring-ring/50 -ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
                {back.label}
              </Link>
            ) : (
              <span aria-hidden="true" />
            )}
            {later ?? <span aria-hidden="true" />}
          </>
        ) : (
          <Logo size={32} />
        )}
      </header>

      {stepper ? (
        <Stepper
          className="mb-8 md:mb-10"
          steps={stepper.steps}
          current={stepper.current}
          fraction={stepper.fraction}
          countLabel={stepper.countLabel}
        />
      ) : null}

      {/* The page's one `<main>`: the auth shell's onboarding branch renders
          no landmark of its own around this frame. */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
