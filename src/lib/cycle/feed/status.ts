/**
 * What the settings card may know about a record's calendar feed (#1350).
 *
 * The token's prefix, the options and the fetch statistics. Never the hash
 * and never the URL: the URL is returned once, by the mint, and after that it
 * exists only where the person pasted it.
 */
import { prisma } from "@/lib/db";
import type { ProjectionState } from "@/lib/cycle/projection";

import { buildCycleFeed, type FeedSubject } from "./build";
import { fetcherFamily, type FetcherFamily } from "./fetcher";
import type { FeedForecastStyle, FeedTitleMode } from "./events";

export const FEED_SUMMARY_SELECT = {
  id: true,
  tokenPrefix: true,
  createdAt: true,
  lastFetchedAt: true,
  fetchCount: true,
  lastFetcherUa: true,
  horizonCycles: true,
  historyCycles: true,
  includeFertile: true,
  titleMode: true,
  forecastStyle: true,
} as const;

export interface FeedSummaryRow {
  id: string;
  tokenPrefix: string;
  createdAt: Date;
  lastFetchedAt: Date | null;
  fetchCount: number;
  lastFetcherUa: string | null;
  horizonCycles: number;
  historyCycles: number;
  includeFertile: boolean;
  titleMode: FeedTitleMode;
  forecastStyle: FeedForecastStyle;
}

export interface CycleFeedSummary {
  tokenPrefix: string;
  createdAt: string;
  lastFetchedAt: string | null;
  fetchCount: number;
  /** Which calendar app fetched last, as a family. Never the raw UA. */
  lastFetcher: FetcherFamily | null;
  horizonCycles: number;
  historyCycles: number;
  includeFertile: boolean;
  titleMode: FeedTitleMode;
  forecastStyle: FeedForecastStyle;
}

export interface CycleFeedStatus {
  /** The live feed, or null when the subscription is off. */
  feed: CycleFeedSummary | null;
  /**
   * What the live feed serves right now (OK / LEARNING / LATE / OFF), so the
   * card can say why it holds fewer cycles than asked. Null with no feed.
   */
  projectionState: ProjectionState | null;
  /** Whether the record's goal admits the fertile-window option at all. */
  fertileAvailable: boolean;
}

export function toFeedSummary(row: FeedSummaryRow): CycleFeedSummary {
  return {
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    fetchCount: row.fetchCount,
    lastFetcher: fetcherFamily(row.lastFetcherUa),
    horizonCycles: row.horizonCycles,
    historyCycles: row.historyCycles,
    includeFertile: row.includeFertile,
    titleMode: row.titleMode,
    forecastStyle: row.forecastStyle,
  };
}

/** The record's live feed, or null. The partial index admits at most one. */
export function findLiveFeed(userId: string): Promise<FeedSummaryRow | null> {
  return prisma.cycleCalendarFeed.findFirst({
    where: { userId, revokedAt: null },
    select: FEED_SUMMARY_SELECT,
  });
}

export async function cycleFeedStatus(
  subject: FeedSubject,
  goal: string,
): Promise<CycleFeedStatus> {
  const live = await findLiveFeed(subject.id);
  const fertileAvailable = goal === "TRYING_TO_CONCEIVE";
  if (!live) return { feed: null, projectionState: null, fertileAvailable };
  const built = await buildCycleFeed(live, subject);
  return {
    feed: toFeedSummary(live),
    projectionState: built.projectionState,
    fertileAvailable,
  };
}
