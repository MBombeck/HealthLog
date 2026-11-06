"use client";

import { useRecordCapabilities } from "@/hooks/use-record-capabilities";

import { CycleCalendarFeedCard } from "./cycle-calendar-feed-card";
import { CycleSettings } from "./cycle-settings";
import type { CycleProfileDTO } from "./types";

/**
 * The cycle page's settings tab: the profile form, then the calendar
 * subscription (#1350). The form remounts on a profile refetch (`key`), the
 * subscription card keeps its own state, including a link it just showed.
 *
 * The card is the owner's on their own record, and a guardian's on a managed
 * profile they manage: the routes behind it (`requireGuardianAuth`) refuse a
 * delegate on an adult's record at every level, so the card is not offered
 * there rather than opening onto a refusal.
 */
export function CycleSettingsTab({ profile }: { profile: CycleProfileDTO }) {
  const { inSharedRecord, recordKind, level } = useRecordCapabilities();
  const mayHoldFeed =
    !inSharedRecord || (recordKind === "managed" && level === "manage");
  return (
    <div className="space-y-4">
      <CycleSettings key={profile.updatedAt} profile={profile} />
      {mayHoldFeed ? <CycleCalendarFeedCard /> : null}
    </div>
  );
}
