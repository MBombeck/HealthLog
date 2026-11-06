"use client";

import { CycleCalendarFeedCard } from "./cycle-calendar-feed-card";
import { CycleSettings } from "./cycle-settings";
import type { CycleProfileDTO } from "./types";

/**
 * The cycle page's settings tab: the profile form, then the calendar
 * subscription (#1350). The form remounts on a profile refetch (`key`), the
 * subscription card keeps its own state, including a link it just showed.
 */
export function CycleSettingsTab({ profile }: { profile: CycleProfileDTO }) {
  return (
    <div className="space-y-4">
      <CycleSettings key={profile.updatedAt} profile={profile} />
      <CycleCalendarFeedCard />
    </div>
  );
}
