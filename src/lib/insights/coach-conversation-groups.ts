/**
 * Bucket Coach conversations by how recently they were last touched: Today,
 * Yesterday, This week (the six days before yesterday), Earlier.
 *
 * Shared by the Coach page's conversations panel and the standalone
 * conversation list, so both group a thread the same way. Comparisons run
 * against LOCAL day boundaries, so "Today" follows the person's own midnight
 * rather than UTC's. Empty groups are dropped; order inside a group is the
 * caller's (the server already returns `updatedAt desc`).
 */
export type CoachRecencyGroupId =
  "today" | "yesterday" | "thisWeek" | "earlier";

export interface CoachRecencyGroup<T> {
  id: CoachRecencyGroupId;
  labelKey: string;
  conversations: T[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const GROUPS: ReadonlyArray<{ id: CoachRecencyGroupId; labelKey: string }> = [
  { id: "today", labelKey: "insights.coach.history.groupToday" },
  { id: "yesterday", labelKey: "insights.coach.history.groupYesterday" },
  { id: "thisWeek", labelKey: "insights.coach.history.groupThisWeek" },
  { id: "earlier", labelKey: "insights.coach.history.groupEarlier" },
];

export function groupConversationsByRecency<T extends { updatedAt: string }>(
  conversations: readonly T[],
  now: Date = new Date(),
): CoachRecencyGroup<T>[] {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - DAY_MS;
  const startOfWeek = startOfToday - 6 * DAY_MS;

  const buckets: Record<CoachRecencyGroupId, T[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const conversation of conversations) {
    const updated = new Date(conversation.updatedAt).getTime();
    if (updated >= startOfToday) buckets.today.push(conversation);
    else if (updated >= startOfYesterday) buckets.yesterday.push(conversation);
    else if (updated >= startOfWeek) buckets.thisWeek.push(conversation);
    else buckets.earlier.push(conversation);
  }

  return GROUPS.map((g) => ({ ...g, conversations: buckets[g.id] })).filter(
    (g) => g.conversations.length > 0,
  );
}
