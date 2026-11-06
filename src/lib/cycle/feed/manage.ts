/**
 * Pieces the calendar-feed management routes share (#1350).
 *
 * Management is cookie-only. Minting hands out a standing URL credential, so
 * it needs the person at the keyboard (a fresh proof on the session) and is
 * not reachable from a Bearer token at all; the native app shows "set up on
 * the web" instead. The routes resolve through `requireRecordAuth("manage",
 * "cycle")`, so the owner and a MANAGE delegate over the cycle section reach
 * them and a READ or WRITE delegate does not.
 */
import { apiError } from "@/lib/api-response";

import { feedPath } from "./token";

/** Mint and rotate, per acting account. */
export const FEED_MINT_LIMIT_PER_HOUR = 10;
export const FEED_MINT_WINDOW_MS = 60 * 60 * 1000;

/** The refusal a Bearer caller gets: management is a web surface. */
export function cookieOnlyRefusal(): Response {
  return apiError("Calendar subscriptions are managed on the web", 403, {
    errorCode: "cycle.feed.cookie_only",
  });
}

export function noLiveFeed(): Response {
  return apiError("No calendar subscription is on", 404, {
    errorCode: "cycle.feed.none",
  });
}

export function feedExists(): Response {
  return apiError(
    "A calendar subscription is already on. Rotate it for a new link.",
    409,
    { errorCode: "cycle.feed.exists" },
  );
}

/** The two forms of the link, built once, at mint. */
export function feedLinks(
  origin: string,
  raw: string,
): { url: string; webcalUrl: string } {
  const url = `${origin}${feedPath(raw)}`;
  return { url, webcalUrl: url.replace(/^https?:/, "webcal:") };
}
