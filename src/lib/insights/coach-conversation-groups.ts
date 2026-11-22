/**
 * Bucket Coach conversations by how recently they were last touched: Today,
 * Yesterday, This week (the six days before yesterday), Earlier.
 *
 * Shared by the Coach page's conversations panel and the standalone
 * conversation list, so both group a thread the same way. Comparisons run
 * on calendar days of the profile zone `tz`, so "Today" follows the person's
 * own midnight rather than UTC's or the browser's. Empty groups are dropped; order inside a group is the
 * caller's (the server already returns `updatedAt desc`).
 */
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

export type CoachRecencyGroupId =
  "today" | "yesterday" | "thisWeek" | "earlier";

export interface CoachRecencyGroup<T> {
  id: CoachRecencyGroupId;
  labelKey: string;
  conversations: T[];
}

const GROUPS: ReadonlyArray<{ id: CoachRecencyGroupId; labelKey: string }> = [
  { id: "today", labelKey: "insights.coach.history.groupToday" },
  { id: "yesterday", labelKey: "insights.coach.history.groupYesterday" },
  { id: "thisWeek", labelKey: "insights.coach.history.groupThisWeek" },
  { id: "earlier", labelKey: "insights.coach.history.groupEarlier" },
];

export function groupConversationsByRecency<T extends { updatedAt: string }>(
  conversations: readonly T[],
  tz: string,
  now: Date = new Date(),
): CoachRecencyGroup<T>[] {
  // Day keys compare as strings. Each boundary is a calendar day, not an
  // instant 24 hours back, which is an hour off after a change of clocks.
  const today = userDayKey(now, tz);
  const yesterday = shiftDateKey(today, -1);
  const weekStart = shiftDateKey(today, -6);

  const buckets: Record<CoachRecencyGroupId, T[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const conversation of conversations) {
    const day = userDayKey(new Date(conversation.updatedAt), tz);
    if (day >= today) buckets.today.push(conversation);
    else if (day >= yesterday) buckets.yesterday.push(conversation);
    else if (day >= weekStart) buckets.thisWeek.push(conversation);
    else buckets.earlier.push(conversation);
  }

  return GROUPS.map((g) => ({ ...g, conversations: buckets[g.id] })).filter(
    (g) => g.conversations.length > 0,
  );
}
