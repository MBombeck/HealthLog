"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The `h1` of every setup screen, and the one place focus goes when a screen
 * arrives.
 *
 * Moving focus to the heading on each step is what lets a screen-reader user
 * follow the flow: without it, a client-side navigation leaves focus on the
 * button that was just pressed, which no longer exists, and the new question
 * is never announced. `preventScroll` keeps the viewport where the layout
 * put it — the heading is at the top of the column anyway.
 *
 * Semibold rather than the app-wide bold PageHeader H1: the onboarding hero
 * is the documented exception (UI-STANDARDS §5). Do not sweep to font-bold.
 */
export function StepHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <header className="space-y-2">
      <h1
        ref={ref}
        id={id}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {title}
      </h1>
      {description ? (
        <p className="text-muted-foreground text-base leading-relaxed">
          {description}
        </p>
      ) : null}
    </header>
  );
}
