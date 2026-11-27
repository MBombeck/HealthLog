/**
 * What the readiness inventory shows, decided once (v1.42, #613).
 *
 * The server decides each lane's status and the verdict; nothing here
 * recounts. This module only orders the lanes for reading (what carries,
 * then what is thin, then what is empty), flattens the gap links, and says
 * when the dismissible card belongs on the timeline.
 */
import type {
  TimelineReadinessLane,
  TimelineReadinessResponse,
  TimelineReadinessStatus,
} from "@/lib/day/contract";

const STATUS_RANK: Record<TimelineReadinessStatus, number> = {
  carries: 0,
  thin: 1,
  empty: 2,
};

/** Lanes in reading order; the server's order is kept within one status. */
export function orderedReadinessLanes(
  readiness: Pick<TimelineReadinessResponse, "lanes">,
): TimelineReadinessLane[] {
  return readiness.lanes
    .map((lane, index) => ({ lane, index }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.lane.status] - STATUS_RANK[b.lane.status] ||
        a.index - b.index,
    )
    .map(({ lane }) => lane);
}

export interface ReadinessGap {
  lane: TimelineReadinessLane["key"];
  key: string;
  count: number;
  href: string;
}

/** Every gap with its one link, in the lanes' reading order. */
export function readinessGaps(
  readiness: Pick<TimelineReadinessResponse, "lanes">,
): ReadinessGap[] {
  return orderedReadinessLanes(readiness).flatMap((lane) =>
    lane.gaps.map((gap) => ({ lane: lane.key, ...gap })),
  );
}

/** How many lanes carry, out of how many are listed. */
export function readinessTally(
  readiness: Pick<TimelineReadinessResponse, "lanes">,
): { carrying: number; total: number } {
  return {
    carrying: readiness.lanes.filter((l) => l.status === "carries").length,
    total: readiness.lanes.length,
  };
}

/**
 * The card belongs on the timeline while a lane is thin or empty and offers
 * a way to close the gap, until the person closes the card.
 */
export function showReadinessCard(
  readiness: Pick<TimelineReadinessResponse, "lanes"> | undefined,
  dismissed: boolean,
): boolean {
  if (!readiness || dismissed) return false;
  return readiness.lanes.some(
    (lane) => lane.status !== "carries" && lane.gaps.length > 0,
  );
}

/** Storage key for the dismissed card; a per-viewer convenience only. */
export const READINESS_CARD_DISMISSED_KEY = "healthlog.timeline.readinessCard";
