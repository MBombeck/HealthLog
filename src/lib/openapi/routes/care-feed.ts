/**
 * OpenAPI route table — the subscribable care dates: the anonymous `.ics`
 * feed of booked visits, check-ups and vaccination boosters coming due, and
 * its cookie-only management route.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The request
 * schema comes from `src/lib/validations/care-feed.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  careFeedOptionsPatchSchema,
  careFeedTitleModeEnum,
} from "@/lib/validations/care-feed";
import { isoDateTime } from "@/lib/validations/datetime";

import {
  dataEnvelope,
  errorEnvelope,
  malformedJsonResponse,
  stdResponses,
} from "./shared";

const fetcherFamilyEnum = z.enum(["GOOGLE", "APPLE", "MICROSOFT", "OTHER"]);

const careFeedSummary = z
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
    includeVisits: z.boolean(),
    includeCheckups: z.boolean(),
    includeVaccinations: z.boolean(),
    titleMode: careFeedTitleModeEnum,
  })
  .meta({
    id: "CareFeedSummary",
    description:
      "The live care calendar subscription, without its secret: never the token hash and never the URL.",
  });

const careFeedStatus = z.object({ feed: careFeedSummary.nullable() });

const careFeedMinted = z.object({
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
  feed: careFeedSummary,
});

const COOKIE_ONLY = {
  "403": {
    description:
      "A Bearer caller (`care.feed.cookie_only`): the subscription is managed over a browser session, on the caller's own record only. Turning it on while the operator's external-access switch is off answers `care.feed.api_disabled`.",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

const NONE_404 = {
  "404": {
    description: "No subscription is on (`care.feed.none`).",
    content: { "application/json": { schema: errorEnvelope } },
  },
};

export const careFeedPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/care/feed/{token}": {
    get: {
      tags: ["Records"],
      summary: "Booked visits and care dates as iCalendar (public)",
      description:
        "Anonymous: a calendar provider polls this URL, so the raw `hlf_` token in the path (optionally followed by `.ics`) is the ONLY credential. Rate-limited per source address before any lookup and per token after it. Every gate is re-read on each fetch: the record is not pending deletion and the operator's external-access switch is on. Every miss is the same 404. The body is RFC 5545: booked visits as one-hour events at their UTC time, check-ups and vaccination boosters as all-day events on the day they come due (the reminder engine's own next-due day, in the record's zone), from 30 days back to 400 days ahead, at most 300 events. Boosters follow the vaccinations module. Titles are one dot by default; descriptive titles name the practitioner or the check-up's label, never a visit's reason, outcome or body site. `ETag` is the content hash; a matching `If-None-Match` answers 304.",
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
          content: { "text/calendar": { schema: z.string() } },
        },
        "304": {
          description: "The body is unchanged since the `If-None-Match` ETag.",
        },
        "404": {
          description:
            "Flat 404 for every miss class (errorCode `care.feed.notFound`).",
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
  "/api/care/feed-subscription": {
    get: {
      tags: ["Records"],
      summary: "Care calendar subscription status",
      description:
        "The caller's live care calendar subscription without its secret (prefix, options, fetch statistics). Never the hash, never the URL.",
      responses: {
        "200": {
          description:
            "The status; `feed` is null while the subscription is off.",
          content: {
            "application/json": {
              schema: dataEnvelope(careFeedStatus, "CareFeedStatus"),
            },
          },
        },
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
    post: {
      tags: ["Records"],
      summary: "Turn the care calendar subscription on",
      description:
        "Mints an `hlf_` token (192-bit), stores only its HMAC, and returns the URL EXACTLY ONCE. One live subscription per record: a second answers 409 `care.feed.exists` (turn it off for a new link). Defaults: visits, check-ups and boosters, discreet titles. Needs a fresh proof (401 `auth.reproof.required`). Rate-limited per account (`care-feed:mint:<userId>`, 10/h).",
      responses: {
        "201": {
          description: "The new link, returned exactly once.",
          content: {
            "application/json": {
              schema: dataEnvelope(careFeedMinted, "CareFeedMinted"),
            },
          },
        },
        "409": {
          description: "A subscription is already on (`care.feed.exists`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
    patch: {
      tags: ["Records"],
      summary: "Change the care calendar subscription's options",
      description:
        "Field-by-field update of the options. The URL does not change; the feed's next fetch serves the new content.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: careFeedOptionsPatchSchema.meta({
              id: "CareFeedOptionsPatch",
              description: "The writable options. At least one field.",
            }),
          },
        },
      },
      responses: {
        "200": {
          description: "The status after the change.",
          content: {
            "application/json": {
              schema: dataEnvelope(careFeedStatus, "CareFeedStatusAfterPatch"),
            },
          },
        },
        ...NONE_404,
        ...COOKIE_ONLY,
        ...malformedJsonResponse,
        ...stdResponses,
      },
    },
    delete: {
      tags: ["Records"],
      summary: "Turn the care calendar subscription off",
      description:
        "Revokes the link; calendars holding it stop updating on their next poll. Copies a calendar provider already holds are beyond the app's reach.",
      responses: {
        "200": {
          description: "Revoked.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ revoked: z.literal(true) }),
                "CareFeedRevoked",
              ),
            },
          },
        },
        ...NONE_404,
        ...COOKIE_ONLY,
        ...stdResponses,
      },
    },
  },
};
