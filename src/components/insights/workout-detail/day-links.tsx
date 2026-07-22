"use client";

import Link from "next/link";
import { Activity, Moon, Smile } from "lucide-react";
import type { ComponentType } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { CalendarDays } from "lucide-react";
import { useTranslations } from "@/lib/i18n/context";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";

interface DayLink {
  href: string;
  labelKey: string;
  icon: ComponentType<{ className?: string }>;
}

const LINKS: DayLink[] = [
  {
    href: "/insights/pulse",
    labelKey: "insights.workouts.detail.dayPulse",
    icon: Activity,
  },
  {
    href: "/insights/sleep",
    labelKey: "insights.workouts.detail.daySleep",
    icon: Moon,
  },
  {
    href: "/insights/mood",
    labelKey: "insights.workouts.detail.dayMood",
    icon: Smile,
  },
];

export interface WorkoutDetailDayLinksProps {
  workout: WorkoutDetailPayload;
}

/**
 * "That day" — a plain inline link row to the day's other signals
 * (intraday pulse, that night's sleep, mood). No reads; just navigation
 * so the workout sits in the context of the rest of the day.
 */
export function WorkoutDetailDayLinks({ workout }: WorkoutDetailDayLinksProps) {
  const { t } = useTranslations();
  void workout;

  return (
    <Card data-slot="workout-detail-day-links">
      <CardHeader>
        <TileHeader
          icon={CalendarDays}
          title={t("insights.workouts.detail.thatDayTitle")}
          titleAs="h2"
        />
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {LINKS.map(({ href, labelKey, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="border-border hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors"
            >
              <Icon
                className="text-muted-foreground size-4"
                aria-hidden="true"
              />
              {t(labelKey)}
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
