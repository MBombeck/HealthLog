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

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { scrollBehaviorForUser } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { queryKeys } from "@/lib/query-keys";
import { DISCLAIMER_VERSION } from "@/lib/onboarding/disclaimer";

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
  const { user } = useAuth();

  const railRef = useRef<HTMLDivElement | null>(null);
  const liveRegionId = useId();
  const disclaimerId = useId();
  const [active, setActive] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  // v1.18.6 (DISC-02) — the one-time medical-disclaimer acknowledgment gates
  // "Get started". Pre-checked for an account that already acknowledged (a
  // re-walk of step 0) so a returning user is not re-asked.
  const [acknowledged, setAcknowledged] = useState(
    () => user?.disclaimerAcknowledgedAt != null,
  );

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
    if (advancing || !acknowledged) return;
    setAdvancing(true);
    try {
      // v1.18.6 (DISC-02) — record the one-time acknowledgment before
      // advancing. Skipped when the account already acknowledged (re-walk).
      if (user?.disclaimerAcknowledgedAt == null) {
        await apiPost("/api/onboarding/disclaimer", {
          version: DISCLAIMER_VERSION,
        });
      }
      await apiPost("/api/onboarding/step", { step: 1 });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/onboarding/1");
    } catch (err) {
      toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));
      setAdvancing(false);
    }
  }

  return (
    <section aria-labelledby="onboarding-welcome-title" className="space-y-6">
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
            "[scrollbar-width:none] scrollbar-none [-ms-overflow-style:none]",
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
              <p className="text-foreground text-sm leading-relaxed">
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
          onClick={() => scrollToSlide(Math.min(SLIDES.length - 1, active + 1))}
          disabled={active === SLIDES.length - 1}
          aria-label={t("onboarding.welcome.nextSlide")}
          aria-controls={liveRegionId}
          className="min-h-11 min-w-11"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* v1.18.6 (DISC-02) — one-time medical-disclaimer acknowledgment. This
          replaces the per-page / per-chart disclaimer banners removed app-wide
          in the same release; the full legal text stays reachable on the
          public privacy page (link below). */}
      <div className="border-border/60 bg-muted/30 flex items-start gap-3 rounded-lg border p-4">
        <Checkbox
          id={disclaimerId}
          checked={acknowledged}
          onCheckedChange={(next) => setAcknowledged(next === true)}
          className="mt-0.5"
        />
        <label
          htmlFor={disclaimerId}
          className="text-foreground text-sm leading-relaxed"
        >
          {t("onboarding.disclaimer.acknowledge")}{" "}
          <Link
            href="/privacy#medical-boundary"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("onboarding.disclaimer.learnMore")}
          </Link>
        </label>
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="button"
          size="lg"
          onClick={handleGetStarted}
          disabled={advancing || !acknowledged}
          className="min-h-11"
        >
          {t("onboarding.welcome.cta")}
        </Button>
      </div>
    </section>
  );
}
