"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  HeartPulse,
  Plug,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { readError } from "@/lib/api/read-error";
import { scrollBehaviorForUser } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W14b-Content — onboarding welcome carousel.
 *
 * Three value-prop slides shown on `/onboarding/0` before any data is
 * asked of the user. Mirrors the Withings / Strava pattern surfaced in
 * the W14b research file (§2.1, §2.5): pitch the product, then ask.
 *
 * Slides:
 *   1. Tagline — "Your health data, owned by you."
 *   2. Multi-source — Apple Health + Withings + manual, one view.
 *   3. AI Coach + Insights — evidence-grounded, your data only.
 *
 * The carousel is a CSS scroll-snap rail; arrow buttons + dot pager
 * mirror the active slide. `prefers-reduced-motion` disables the smooth
 * scroll behaviour (per WCAG 2.3.3 / research §4.6).
 *
 * The primary CTA ("Get started") POSTs `/api/onboarding/step` with
 * `{ step: 1 }`. On success it invalidates the `auth` query (so the
 * user-shape's `onboardingStep` re-reads) and pushes to `/onboarding/1`.
 */

interface CarouselSlide {
  id: "tagline" | "sources" | "coach";
  Icon: LucideIcon;
  titleKey: string;
  bodyKey: string;
}

const SLIDES: ReadonlyArray<CarouselSlide> = [
  {
    id: "tagline",
    Icon: HeartPulse,
    titleKey: "onboarding.welcome.slide1.title",
    bodyKey: "onboarding.welcome.slide1.body",
  },
  {
    id: "sources",
    Icon: Plug,
    titleKey: "onboarding.welcome.slide2.title",
    bodyKey: "onboarding.welcome.slide2.body",
  },
  {
    id: "coach",
    Icon: Sparkles,
    titleKey: "onboarding.welcome.slide3.title",
    bodyKey: "onboarding.welcome.slide3.body",
  },
];

export function WelcomeCarousel() {
  const { t } = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();

  const railRef = useRef<HTMLDivElement | null>(null);
  const liveRegionId = useId();
  const [active, setActive] = useState(0);
  const [advancing, setAdvancing] = useState(false);

  // Track which slide is centred in the rail. We observe each slide
  // with an IntersectionObserver — simpler and more reliable than
  // computing scroll-positions, and it handles touch flings naturally.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const slides = Array.from(
      rail.querySelectorAll<HTMLElement>("[data-slide-index]"),
    );
    if (slides.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        // Pick the entry whose intersection ratio is highest — that's
        // the slide currently snapped into view.
        let best: { idx: number; ratio: number } | null = null;
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.slideIndex);
          if (!Number.isFinite(idx)) continue;
          if (!best || e.intersectionRatio > best.ratio) {
            best = { idx, ratio: e.intersectionRatio };
          }
        }
        if (best && best.ratio > 0.5) {
          setActive(best.idx);
        }
      },
      { root: rail, threshold: [0.5, 0.75, 1] },
    );

    for (const s of slides) io.observe(s);
    return () => io.disconnect();
  }, []);

  const scrollToSlide = useCallback((idx: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const target = rail.querySelector<HTMLElement>(
      `[data-slide-index="${idx}"]`,
    );
    if (!target) return;
    target.scrollIntoView({
      behavior: scrollBehaviorForUser(),
      inline: "start",
      block: "nearest",
    });
  }, []);

  async function handleGetStarted() {
    if (advancing) return;
    setAdvancing(true);
    try {
      const res = await fetch("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: 1 }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/onboarding/1");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("onboarding.errorGeneric");
      toast.error(message);
      setAdvancing(false);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-welcome-title"
      className="space-y-6"
    >
      <h1
        id="onboarding-welcome-title"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        {t("onboarding.welcome.title")}
      </h1>

      <div className="relative">
        <div
          ref={railRef}
          role="region"
          aria-roledescription="carousel"
          aria-label={t("onboarding.welcome.carouselLabel")}
          className={cn(
            "flex w-full snap-x snap-mandatory gap-4 overflow-x-auto",
            // Hide native scrollbar; the dot pager is the visible affordance.
            "scrollbar-none [-ms-overflow-style:none] [scrollbar-width:none]",
            "[&::-webkit-scrollbar]:hidden",
            "scroll-smooth motion-reduce:scroll-auto",
          )}
        >
          {SLIDES.map((slide, idx) => (
            <article
              key={slide.id}
              data-slide-index={idx}
              role="group"
              aria-roledescription="slide"
              aria-labelledby={`onboarding-welcome-slide-${slide.id}-title`}
              className={cn(
                "bg-card border-border flex w-full shrink-0 snap-start flex-col items-center gap-4",
                "rounded-xl border p-6 text-center sm:p-8",
              )}
            >
              <span
                aria-hidden="true"
                className="bg-primary/10 text-primary flex size-16 items-center justify-center rounded-full"
              >
                <slide.Icon className="size-8" />
              </span>
              <h2
                id={`onboarding-welcome-slide-${slide.id}-title`}
                className="text-lg font-semibold tracking-tight"
              >
                {t(slide.titleKey)}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {t(slide.bodyKey)}
              </p>
            </article>
          ))}
        </div>

        {/* Single live region announces slide changes to AT users —
            slides themselves carry `aria-label="slide N of total"` so a
            second sr-only mirror would double-announce on every move.
            The carousel-level region wins because it's tied to the
            chevron + dot pager via `aria-controls`. */}
        <p id={liveRegionId} aria-live="polite" className="sr-only">
          {t("onboarding.welcome.slideOf", {
            current: active + 1,
            total: SLIDES.length,
          })}
        </p>
      </div>

      <div className="flex items-center justify-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => scrollToSlide(Math.max(0, active - 1))}
          disabled={active === 0}
          aria-label={t("onboarding.welcome.prevSlide")}
          aria-controls={liveRegionId}
          className="min-h-11 min-w-11"
        >
          <ChevronLeft className="size-4" />
        </Button>

        <div
          role="tablist"
          aria-label={t("onboarding.welcome.carouselLabel")}
          className="flex items-center"
        >
          {SLIDES.map((slide, idx) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={active === idx}
              aria-label={t("onboarding.welcome.gotoSlide", {
                index: idx + 1,
              })}
              onClick={() => scrollToSlide(idx)}
              className="inline-flex size-11 items-center justify-center"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 rounded-full transition-colors duration-150 ease-out motion-reduce:transition-none",
                  active === idx
                    ? "bg-primary"
                    : "bg-muted hover:bg-muted-foreground/30",
                )}
              />
            </button>
          ))}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() =>
            scrollToSlide(Math.min(SLIDES.length - 1, active + 1))
          }
          disabled={active === SLIDES.length - 1}
          aria-label={t("onboarding.welcome.nextSlide")}
          aria-controls={liveRegionId}
          className="min-h-11 min-w-11"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="button"
          size="lg"
          onClick={handleGetStarted}
          disabled={advancing}
          className="min-h-11"
        >
          {t("onboarding.welcome.cta")}
        </Button>
      </div>
    </section>
  );
}

