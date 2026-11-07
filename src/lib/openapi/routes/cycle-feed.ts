/**
 * OpenAPI route table — the subscribable cycle forecast (#1350): the
 * anonymous `.ics` feed, its cookie-only management routes, and the
 * projection the calendar read publishes beside its forecast.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * schema comes from `src/lib/validations/cycle-feed.ts`, so the wire contract
 * stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  cycleFeedOptionsPatchSchema,
  cycleFeedTitleModeEnum,
} from "@/lib/validations/cycle-feed";
import { isoDateTime } from "@/lib/validations/datetime";

import {
  dataEnvelope,
  errorEnvelope,
  malformedJsonResponse,
  recordRefusal,
  recordWriteRateLimitResponse,
  stdResponses,
} from "./shared";

const dayKey = () => z.string().meta({ format: "date", example: "2026-11-12" });

/** One projected period, as `/api/cycle/calendar` publishes it. */
export const projectedCycleDto = z
  .object({
    k: z
      .number()
      .int()
      .describe(
        "1 = the next period (the engine's own forecast), 2 = the one after it, …",
      ),
    start: dayKey().describe("The most likely first day."),
    periodLength: z.number().int().describe("Predicted bleeding days."),
    bandStart: dayKey().describe("The earliest likely first day."),
    bandEnd: dayKey().describe("The latest likely first day."),
  })
  .meta({
    id: "ProjectedCycleDTO",
    description:
      "A forecast period start with its band. The band widens from one cycle to the next and the list stops itself where it would pass ±10 days or half a cycle. Render it as given; never extrapolate further cycles on a client.",
  });

export const projectionStateEnum = z
  .enum(["OK", "LEARNING", "LATE", "OFF"])
  .meta({
    id: "CycleProjectionState",
    description:
      "Why `projection` holds what it holds. `OK`: the projected cycles. `LEARNING`: fewer than three observed cycles, so the next period only (or nothing with no logged cycle). `LATE`: the next period's band has passed with no new period logged; no forecast until one is. `OFF`: prediction is off or raw-chart mode is on.",
  });

const fetcherFamilyEnum = z.enum(["GOOGLE", "APPLE", "MICROSOFT", "OTHER"]);

const feedSummary = z
  .object({
    tokenPrefix: z
      .string()
      .describe(
        "The first 8 characters of the link's token, to tell links apart.",
      ),
    createdAt: isoDateTime(),
    lastFetchedAt: isoDateTime().nullable(),
    fetchCount: z.number().int(),
    lastFetcher: fetcherFamilyEnum
      .nullable()
      .describe(
        "Which calendar app fetched last, as a family; never the raw User-Agent.",
      ),
    horizonCycles: z.number().int().min(1).max(6),
    historyCycles: z.number().int().min(0).max(12),
    includeFertile: z.boolean(),
    titleMode: cycleFeedTitleModeEnum,
  })
  .meta({
    id: "CycleFeedSummary",
    description:
      "The live calendar subscription, without its secret: never the token hash and never the URL.",
  });

const feedStatus = z.object({
  feed: feedSummary.nullable(),
  projectionState: projectionStateEnum.nullable(),
  fertileAvailable: z
    .boolean()
    .describe(
      "Whether the record's goal admits the fertile-window option (TRYING_TO_CONCEIVE only).",
    ),
});

const feedMinted = z.object({
  url: z
    .string()
    .describe(
      "The feed URL. Returned exactly once; it cannot be read back later.",
    ),
  webcalUrl: z
    .string()
    .describe(
      "The same URL with the `webcal:` scheme, which opens a calendar app's subscribe dialog.",
    ),
  feed: feedSummary,
});

const feedOptionsRequest = cycleFeedOptionsPatchSchema.meta({
  id: "CycleFeedOptionsPatch",
  description:
    "The writable options. At least one field. `includeFertile: true` is refused (422 `cycle.feed.fertile_goal`) unless the goal is TRYING_TO_CONCEIVE.",
});

const MANAGEMENT_REFUSALS = recordRefusal(
  "Calendar subscriptions are managed over a browser session only: any Bearer token gets `cycle.feed.cookie_only`. Cycle tracking switched off for the record answers `cycle.disabled`; the operator's external-access switch answers `cycle.feed.api_disabled` on turning it on and on rotating. Reached by the record's owner on their own record and by the guardian of a managed profile; a delegate on an adult's record is refused at every grant level, MANAGE included.",
);

const REPROOF_401 = {
  "401": {
    description:
      "Not signed in, or the session has no fresh proof: turning the subscription on or rotating it needs a sign-in or `POST /api/auth/reproof` within the last five minutes, answered otherwise with 401 `auth.reproof.required` and `meta.methods`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const mintResponses = {
  "201": {
    description: "The new link, returned exactly once.",
    content: {
      "application/json": {
        schema: dataEnvelope(feedMinted, "CycleFeedMinted"),
      },
    },
  },
  ...MANAGEMENT_REFUSALS,
  ...stdResponses,
  ...REPROOF_401,
};

export const cycleFeedPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/cycle/feed/{token}": {
    get: {
      tags: ["Cycle"],
      summary: "The subscribable cycle forecast as iCalendar (public, #1350)",
      description:
        "Anonymous: a calendar provider polls this URL, so the raw `hlf_` token in the path (optionally followed by `.ics`) is the ONLY credential. Rate-limited per source address before any lookup and per token after it. Every gate is re-read on each fetch: the record and the minting account are not pending deletion, the operator's external-access switch is on, cycle tracking is available, and a feed minted by a managed profile's guardian still sits on a managed profile the guardian holds a live MANAGE grant over. Every miss (malformed, unknown, revoked, switched off, deleted, lapsed grant) is the same 404. The body is RFC 5545: all-day events, dates only, discreet titles by default, the next few periods with widening bands (self-capped), optionally past periods and, for TRYING_TO_CONCEIVE, the next fertile window. `ETag` is the content hash; a matching `If-None-Match` answers 304.",
      security: [],
      requestParams: {
        path: z.object({
          token: z
            .string()
            .describe("Raw `hlf_` feed token, optionally with `.ics`."),
        }),
      },
      responses: {
        "200": {
          description:
            "The calendar. `Cache-Control: private, no-cache, max-age=0`, `ETag`.",
          content: {
            "text/calendar": { schema: z.string() },
          },
        },
        "304": {
          description: "The body is unchanged since the `If-None-Match` ETag.",
        },
        "404": {
          description:
            "Flat 404 for every miss class (errorCode `cycle.feed.notFound`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "429": {
          description: "The source-address or per-token bucket is exhausted.",
          content: { "application/json": { schema: errorEnvelope } },
          headers: stdResponses["429"].headers,
        },
      },
    },
  },
  "/api/cycle/feed-subscription": {
    get: {
      tags: ["Cycle"],
      summary: "Calendar subscription status (#1350)",
      description:
        "The record's live calendar subscription without its secret (prefix, options, fetch statistics) and what the feed serves right now. Never the hash, never the URL.",
      responses: {
        "200": {
          description:
            "The status; `feed` is null while the subscription is off.",
          content: {
            "application/json": {
              schema: dataEnvelope(feedStatus, "CycleFeedStatus"),
            },
          },
        },
        ...MANAGEMENT_REFUSALS,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Cycle"],
      summary: "Turn the calendar subscription on (#1350)",
      description:
        "Mints an `hlf_` token (192-bit), stores only its HMAC, and returns the URL EXACTLY ONCE. One live subscription per record: a second answers 409 `cycle.feed.exists` (rotate instead). Defaults: three cycles ahead, no history, no fertile window, discreet titles. Rate-limited per acting account (`cycle-feed:mint:<actorId>`, 10/h, shared with rotate).",
      responses: {
        ...mintResponses,
        "409": {
          description: "A subscription is already on (`cycle.feed.exists`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
    patch: {
      tags: ["Cycle"],
      summary: "Change the calendar subscription's options (#1350)",
      description:
        "Field-by-field update of the options. The URL does not change; the feed's next fetch serves the new content.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: feedOptionsRequest } },
      },
      responses: {
        "200": {
          description: "The status after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(feedStatus, "CycleFeedStatusAfterPatch"),
            },
          },
        },
        "404": {
          description: "No subscription is on (`cycle.feed.none`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...MANAGEMENT_REFUSALS,
        ...malformedJsonResponse,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
    delete: {
      tags: ["Cycle"],
      summary: "Turn the calendar subscription off (#1350)",
      description:
        "Revokes the link; calendars holding it stop updating on their next poll. Copies a calendar provider already holds are beyond the app's reach.",
      responses: {
        "200": {
          description: "Revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "CycleFeedRevoked",
              ),
            },
          },
        },
        "404": {
          description: "No subscription is on (`cycle.feed.none`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...MANAGEMENT_REFUSALS,
        ...stdResponses,
        ...recordWriteRateLimitResponse,
      },
    },
  },
  "/api/cycle/feed-subscription/rotate": {
    post: {
      tags: ["Cycle"],
      summary: "Replace the calendar subscription's link (#1350)",
      description:
        "One transaction: the live link is revoked and a new one minted with the same options. Returns the new URL EXACTLY ONCE. Calendars using the old link stop updating. Of two rotations racing, the one that loses answers 409 `cycle.feed.exists` and the winner's link stands.",
      responses: {
        ...mintResponses,
        "404": {
          description: "No subscription is on (`cycle.feed.none`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "409": {
          description:
            "Another rotation replaced the link at the same moment (`cycle.feed.exists`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
};
