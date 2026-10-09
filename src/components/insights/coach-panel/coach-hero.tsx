"use client";

import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.18.9 — the Coach new-chat hero (page surface only).
 *
 * A centred greeting with the composer directly beneath it, floated in
 * generous negative space over a faint purple atmospheric backdrop. This
 * replaces the cramped bottom-pinned empty thread with a calm,
 * ChatGPT/Claude-grade prompt surface. On first send the conversation
 * branch takes over and the composer docks to the bottom (handled by
 * `<CoachConversation>`).
 *
 * The hero does NOT fork composer logic: it RECEIVES the live
 * `<CoachInput>` as the `composer` slot, so dictation, auto-grow, the
 * send/stop control, and the guided-question placeholder all behave
 * exactly as in the docked composer.
 *
 * v1.18.10 (W4) — the starter-question suggestion chips below the composer
 * are removed (maintainer feedback): the hero is greeting + composer only,
 * matching the reference ChatGPT/Claude new-chat surface.
 *
 * Motion: one orchestrated reveal — sparkle → greeting → composer stagger
 * in via `motion-safe` `animate-in` with capped delays; reduced-motion
 * users get the layout instantly.
 *
 * The space under the composer stays empty: no suggested prompts and no
 * openers, so an empty conversation is the greeting and the field.
 */
export interface CoachHeroProps {
  /** The live `<CoachInput>` composer, re-parented into the hero. */
  composer: React.ReactNode;
}

export function CoachHero({ composer }: CoachHeroProps) {
  const { t } = useTranslations();

  return (
    <div
      data-slot="coach-hero"
      className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-8 sm:px-6"
    >
      {/* Atmospheric backdrop — a faint purple radial glow behind the
          hero, never busy. Pointer-events-none + aria-hidden so it is
          purely decorative; it sits behind the content via -z-10. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 -z-10",
          "bg-[radial-gradient(60%_50%_at_50%_38%,color-mix(in_srgb,var(--primary)_14%,transparent),transparent_70%)]",
        )}
      />

      <div className="flex w-full max-w-2xl flex-col items-center gap-6 text-center">
        {/* Sparkle mark */}
        <div
          aria-hidden="true"
          className={cn(
            "from-primary to-brand-pink flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br shadow-sm",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500",
          )}
        >
          <Sparkles className="text-background size-6" />
        </div>

        {/* Greeting — one line. A slightly larger, tighter display
            treatment of the existing font (weight/tracking/size only, no
            new font). The earlier two-line subline was dropped: the
            new-chat surface reads as a single calm invitation. */}
        <div
          className={cn(
            "flex flex-col",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
          )}
          style={{ animationDelay: "80ms", animationFillMode: "both" }}
        >
          <h1 className="text-foreground text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("insights.coach.heroGreeting")}
          </h1>
        </div>

        {/* Composer — the live <CoachInput>, centred. */}
        <div
          data-slot="coach-hero-composer"
          className={cn(
            "w-full",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
          )}
          style={{ animationDelay: "160ms", animationFillMode: "both" }}
        >
          {composer}
        </div>
      </div>
    </div>
  );
}
