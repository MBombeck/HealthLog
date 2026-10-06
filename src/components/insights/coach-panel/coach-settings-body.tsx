"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Brain, ChevronRight, Cpu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

import { COACH_MEMORY_LIST_KEYS } from "@/lib/ai/coach/memory/shared";

import { CoachModelPicker } from "./coach-model-picker";
import { CoachReasoningField } from "./coach-reasoning-field";
import { useCoachFacts } from "./use-coach-facts";
import { SourcesRail } from "./sources-rail";

/**
 * The content of the Coach's quick settings (see `coach-settings-overlay`):
 * the model choice and how hard the Coach thinks, a way to what it remembers,
 * "What I can see" (the existing sources rail, wired to the saved Coach
 * preferences: data areas and how far back the Coach looks) and a way on to
 * the full AI settings.
 *
 * `focusData` lands focus on the "What I can see" section when the body
 * mounts, for the `/coach?settings=data` deep link. It runs here rather than
 * in the overlay because the body loads on demand and may arrive after the
 * popover or sheet has already placed focus. The section draws no focus
 * ring: it is where the link lands, not a control, and a ring drawn on every
 * deep link reads as a highlight nobody asked for.
 */
export const COACH_SETTINGS_DATA_SECTION_ID = "coach-settings-data";

/** Where the memory list lives: Settings → Coach, its memory card. */
export const COACH_MEMORY_HREF = "/settings/coach#coach-memory";

/** "Memory (8)": a link to the list, with how much it holds. */
function CoachMemoryLink() {
  const { t } = useTranslations();
  const facts = useCoachFacts();
  const count = facts.data?.length ?? 0;
  return (
    <Link
      href={COACH_MEMORY_HREF}
      data-slot="coach-settings-memory-link"
      className="text-foreground hover:bg-muted focus-visible:ring-ring/50 -mx-2 flex min-h-11 items-center gap-2 rounded-md px-2 text-sm outline-none focus-visible:ring-2 sm:min-h-9"
    >
      <Brain
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        {t(COACH_MEMORY_LIST_KEYS.link, { count })}
      </span>
      <ChevronRight
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
    </Link>
  );
}

export function CoachSettingsBody({
  focusData = false,
}: {
  focusData?: boolean;
}) {
  const { t } = useTranslations();
  const dataRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!focusData) return;
    const frame = requestAnimationFrame(() => {
      dataRef.current?.focus();
      dataRef.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusData]);
  return (
    <div data-slot="coach-settings-body" className="flex flex-col gap-4">
      <section
        aria-labelledby="coach-settings-model-heading"
        data-slot="coach-settings-model"
        className="flex flex-col gap-3"
      >
        <h3
          id="coach-settings-model-heading"
          className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase"
        >
          <Cpu className="text-muted-foreground size-3.5" aria-hidden="true" />
          {t("insights.coach.frame.modelSection")}
        </h3>
        <CoachModelPicker />
        <CoachReasoningField id="coach-quick-reasoning" />
        <CoachMemoryLink />
      </section>
      <section
        ref={dataRef}
        id={COACH_SETTINGS_DATA_SECTION_ID}
        data-slot="coach-settings-data"
        tabIndex={-1}
        aria-label={t("insights.coach.sourcesTitle")}
        className="border-border border-t pt-4 outline-none"
      >
        <SourcesRail className="h-auto p-0" />
      </section>
      <div className="border-border border-t pt-4">
        <Button asChild variant="outline" size="sm" className="min-h-11">
          <Link href="/settings/ai" data-slot="coach-settings-all">
            {t("insights.coach.frame.allSettings")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
