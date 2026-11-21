/**
 * What the care-feed management route shares: the refusals, the link forms
 * and the status the settings card may know.
 *
 * Management is cookie-only and serves the caller's own record
 * (`requireActorAuth`): the feed is a standing credential whose contents end
 * up in a third party's calendar cloud, so only the person the dates are
 * about may make one, from a session, with a fresh proof to turn it on.
 *
 * The status is the token's prefix, the options and the fetch statistics.
 * Never the hash and never the URL: the URL is returned once, by the mint.
 */
import { apiError } from "@/lib/api-response";
import { fetcherFamily, type FetcherFamily } from "@/lib/cycle/feed/fetcher";
import { prisma } from "@/lib/db";

import type { CareFeedTitleMode } from "./events";

/** Mint, per account. */
export const CARE_FEED_MINT_LIMIT_PER_HOUR = 10;
export const CARE_FEED_MINT_WINDOW_MS = 60 * 60 * 1000;

/** The feed path for a raw token, relative to the instance origin. */
export function careFeedPath(raw: string): string {
  return `/api/care/feed/${raw}.ics`;
}

/** The two forms of the link, built once, at mint. */
export function careFeedLinks(
  origin: string,
  raw: string,
): { url: string; webcalUrl: string } {
  const url = `${origin}${careFeedPath(raw)}`;
  return { url, webcalUrl: url.replace(/^https?:/, "webcal:") };
}

export function careCookieOnlyRefusal(): Response {
  return apiError("Calendar subscriptions are managed on the web", 403, {
    errorCode: "care.feed.cookie_only",
  });
}

export function careNoLiveFeed(): Response {
  return apiError("No calendar subscription is on", 404, {
    errorCode: "care.feed.none",
  });
}

export function careFeedExists(): Response {
  return apiError(
    "A calendar subscription is already on. Turn it off for a new link.",
    409,
    { errorCode: "care.feed.exists" },
  );
}

export const CARE_FEED_SUMMARY_SELECT = {
  id: true,
  tokenPrefix: true,
  createdAt: true,
  lastFetchedAt: true,
  fetchCount: true,
  lastFetcherUa: true,
  includeVisits: true,
  includeCheckups: true,
  includeVaccinations: true,
  titleMode: true,
} as const;

export interface CareFeedSummaryRow {
  id: string;
  tokenPrefix: string;
  createdAt: Date;
  lastFetchedAt: Date | null;
  fetchCount: number;
  lastFetcherUa: string | null;
  includeVisits: boolean;
  includeCheckups: boolean;
  includeVaccinations: boolean;
  titleMode: CareFeedTitleMode;
}

export interface CareFeedSummary {
  tokenPrefix: string;
  createdAt: string;
  lastFetchedAt: string | null;
  fetchCount: number;
  /** Which calendar app fetched last, as a family. Never the raw UA. */
  lastFetcher: FetcherFamily | null;
  includeVisits: boolean;
  includeCheckups: boolean;
  includeVaccinations: boolean;
  titleMode: CareFeedTitleMode;
}

export function toCareFeedSummary(row: CareFeedSummaryRow): CareFeedSummary {
  return {
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
    fetchCount: row.fetchCount,
    lastFetcher: fetcherFamily(row.lastFetcherUa),
    includeVisits: row.includeVisits,
    includeCheckups: row.includeCheckups,
    includeVaccinations: row.includeVaccinations,
    titleMode: row.titleMode,
  };
}

/** The record's live feed, or null. The partial index admits at most one. */
export function findLiveCareFeed(
  userId: string,
): Promise<CareFeedSummaryRow | null> {
  return prisma.careCalendarFeed.findFirst({
    where: { userId, revokedAt: null },
    select: CARE_FEED_SUMMARY_SELECT,
  });
}
