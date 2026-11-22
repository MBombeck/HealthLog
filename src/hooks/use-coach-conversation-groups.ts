import { useMemo } from "react";

import {
  groupConversationsByRecency,
  type CoachRecencyGroup,
} from "@/lib/insights/coach-conversation-groups";
import { useDisplayTimezone } from "@/lib/i18n/context";

/** The Coach conversations grouped by recency, on the profile zone's days. */
export function useCoachConversationGroups<T extends { updatedAt: string }>(
  conversations: readonly T[],
): CoachRecencyGroup<T>[] {
  const tz = useDisplayTimezone();
  return useMemo(
    () => groupConversationsByRecency(conversations, tz),
    [conversations, tz],
  );
}
