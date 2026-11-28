"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The `h1` of every setup screen, and the one place focus goes when a screen
 * arrives.
 *
 * Moving focus to the heading on each step is what lets a screen-reader user
 * follow the flow: without it, a client-side navigation leaves focus on the
 * button that was just pressed, which no longer exists, and the new question
 * is never announced. `preventScroll` keeps the viewport where the layout
 * put it.
 *
 * One sentence under it. Muted by default; a sentence that carries consent
 * or a safety fact (a deadline, where data goes) is `tone="foreground"`
 * (ui-standards §3).
 *
 * Semibold rather than the app-wide bold PageHeader H1: the onboarding hero
 * is the documented exception (ui-standards.md §5). Do not sweep to font-bold.
 */
export function StepHeading({
  id,
  title,
  description,
  tone = "muted",
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: "muted" | "foreground";
}) {
  const ref = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <header className="mb-6 space-y-2">
      <h1
        ref={ref}
        id={id}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight outline-none"
      >
        {title}
      </h1>
      {description ? (
        <p
          className={cn(
            "text-sm leading-relaxed",
            tone === "foreground" ? "text-foreground" : "text-muted-foreground",
          )}
          data-slot="onboarding-step-description"
        >
          {description}
        </p>
      ) : null}
    </header>
  );
}
