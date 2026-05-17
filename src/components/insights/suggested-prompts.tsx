"use client";

import { Quote } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { cn } from "@/lib/utils";

/**
 * v1.4.20 phase B1 — "Try asking" prompt-chip strip.
 *
 * Renders a horizontal row of clickable prompt chips below the hero
 * action band. Each chip is a single i18n string; clicking a chip
 * invokes `onPick` with the localised string so the parent can route
 * to the future Coach drawer (B2) or pre-fill an input.
 *
 * Mobile-first: chips wrap to multiple rows on narrow viewports.
 *
 * The default 5-chip ordering mirrors the design handoff
 * (`prototype/artboard-fullpage.jsx → BriefingHero` quick-prompts
 * row). Each label lives in `messages/{en,de}.json` under
 * `insights.suggestedPrompts.<key>` so the parent stays Locale-
 * agnostic.
 */
export interface SuggestedPromptsProps {
  /**
   * Override the default prompt list. When omitted, the component
   * resolves the 5 defaults from `insights.suggestedPrompts.*`.
   * Useful for tests + future per-user prompt sets.
   */
  prompts?: string[];
  /** Click handler — receives the localised prompt string. */
  onPick: (prompt: string) => void;
  /** Optional className passthrough for layout overrides. */
  className?: string;
}

const DEFAULT_PROMPT_KEYS = [
  "whyMonday",
  "weightVsPulse",
  "weekVsMonth",
  "tellMyDoctor",
  "medicationWorking",
] as const;

export function SuggestedPrompts({
  prompts,
  onPick,
  className,
}: SuggestedPromptsProps) {
  const { t } = useTranslations();
  // v1.4.37 W5 — every chip is a Coach affordance: clicking one seeds
  // the Coach drawer's composer and opens it. When the operator turns
  // the global Coach flag off the strip must vanish along with the
  // hero action button and the drawer mount. The HeroStrip caller
  // already guards on `flags.coach`; the in-component gate is
  // defence-in-depth so a future caller that mounts <SuggestedPrompts>
  // outside the hero band can never leak a Coach surface.
  const flags = useFeatureFlags();
  if (!flags.coach) return null;
  const items =
    prompts ??
    DEFAULT_PROMPT_KEYS.map((key) => t(`insights.suggestedPrompts.${key}`));

  return (
    <div
      data-slot="insights-suggested-prompts"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <span
        data-slot="insights-suggested-prompts-label"
        className="text-muted-foreground mr-1 text-[11px] font-medium tracking-wide uppercase"
      >
        {t("insights.suggestedPrompts.label")}
      </span>
      {items.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          data-slot="insights-suggested-prompts-chip"
          className={cn(
            "border-dracula-purple/18 hover:border-dracula-purple/40 hover:text-foreground",
            "text-muted-foreground inline-flex min-h-11 items-center gap-1.5",
            "rounded-full border bg-transparent px-3.5 py-2 text-[13px]",
            "transition-colors focus-visible:ring-2 focus-visible:outline-none",
            "focus-visible:ring-dracula-purple/50",
          )}
        >
          <Quote className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{prompt}</span>
        </button>
      ))}
    </div>
  );
}
