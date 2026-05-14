import type { ReactNode } from "react";

/**
 * v1.4.25 W14b — onboarding route-segment layout.
 *
 * Intentionally pass-through. The `OnboardingShell` chrome lives inside
 * each `[step]/page.tsx` so the existing `/onboarding` root page
 * (`page.tsx` — the legacy v1.4.20 single-file wizard) keeps rendering
 * unchanged while the rebuilt multi-step flow ships beside it. The
 * Content agent that follows W14b-Foundation will swap the root page's
 * redirect target once every step has real content.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <div className="bg-background min-h-[100svh] w-full">{children}</div>;
}
