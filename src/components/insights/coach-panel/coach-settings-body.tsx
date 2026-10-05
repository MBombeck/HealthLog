"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Cpu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

import { CoachModelPicker } from "./coach-model-picker";
import { SourcesRail } from "./sources-rail";

/**
 * The content of the Coach's quick settings (see `coach-settings-overlay`):
 * the model choice, "What I can see" (the existing sources rail, wired to the
 * saved Coach preferences: data areas and how far back the Coach looks) and
 * a way on to the full AI settings.
 *
 * `focusData` lands focus on the "What I can see" section when the body
 * mounts, for the `/coach?settings=data` deep link. It runs here rather than
 * in the overlay because the body loads on demand and may arrive after the
 * popover or sheet has already placed focus.
 */
export const COACH_SETTINGS_DATA_SECTION_ID = "coach-settings-data";

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
      </section>
      <section
        ref={dataRef}
        id={COACH_SETTINGS_DATA_SECTION_ID}
        data-slot="coach-settings-data"
        tabIndex={-1}
        aria-label={t("insights.coach.sourcesTitle")}
        className="border-border focus-visible:ring-ring/50 border-t pt-4 outline-none focus-visible:ring-2"
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
