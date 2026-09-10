import type { ReactNode } from "react";

/**
 * The setup flow's route-segment layout.
 *
 * Pass-through on purpose: the `OnboardingShell` chrome is rendered by each
 * page, because the shell's counter and step list depend on the flow state
 * the page loads, and a layout cannot read what its page decided.
 */
export default function OnboardingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="bg-background min-h-[100svh] w-full">{children}</div>;
}
