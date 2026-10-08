/**
 * OpenAPI route table — the environmental-context module.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. Request shapes
 * come from `@/lib/validations/environment`, so the published contract and
 * the runtime parse are the same objects.
 *
 * The module stores one coarse home location plus any number of travel
 * overrides, and a nightly job resolves a day's weather against whichever of
 * them covers it. Everything on this surface is opt-in and module-gated: with
 * the `environment` module off, every one of the six paths answers 403
 * `module.disabled` before it does anything else.
 *
 * Coordinates are rounded to 1 decimal (about 11 km) on the way in, as a
 * floor under whatever precision a client sends. That rounding is why the
 * geocode results and the stored home read back coarser than they were
 * picked.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import {
  environmentBackfillSchema,
  geocodeQuerySchema,
  homeLocationSchema,
  travelLocationSchema,
} from "@/lib/validations/environment";
import { ENVIRONMENT_MAX_BACKFILL_DAYS } from "@/lib/environment/service";
import {
  dataEnvelope,
  errorEnvelope,
  moduleDisabledResponse,
  stdResponses,
} from "./shared";

const homeLocationRequest = homeLocationSchema.meta({
  id: "EnvironmentHomeRequest",
  description:
    "The coarse home location to store. `timezone` is checked against the runtime IANA set rather than accepted as free text — a bogus zone would mis-key every stored environment day for the account. Strict: an unknown key is a 422.",
});

const travelLocationRequest = travelLocationSchema.meta({
  id: "EnvironmentTravelRequest",
  description:
    "A manual travel override covering an inclusive [startDate, endDate] range. A declared trip dominates the home fallback for every day it covers. Strict, and `startDate` must be on or before `endDate`.",
});

const backfillRequest = environmentBackfillSchema.meta({
  id: "EnvironmentBackfillRequest",
  description:
    "The span to fetch. Both bounds are optional — omitting them asks for the conservative `[homeSince .. today]` range rather than a fixed reach into the past under the current home. Strict.",
});

const geocodeQuery = geocodeQuerySchema.meta({
  id: "EnvironmentGeocodeQuery",
  description: "Free-text place search, 1–120 characters after trimming.",
});

const environmentHome = z
  .object({
    lat: z
      .number()
      .describe("Coarse latitude, rounded to 1 decimal (about 11 km)."),
    lon: z.number().describe("Coarse longitude, rounded to 1 decimal."),
    label: z.string().nullable(),
    timezone: z
      .string()
      .describe(
        "The home's IANA zone. Falls back to the account's display timezone when the home was stored without one.",
      ),
    since: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Effective-from instant. Every set/update re-stamps it: a home resolves days from the moment it was set, and days before it stay un-attributed unless a travel override covers them.",
      ),
  })
  .meta({
    id: "EnvironmentHome",
    description: "The account's stored coarse home location.",
  });

const environmentTravel = z
  .object({
    id: z.string(),
    startDate: z.string().describe("Inclusive YYYY-MM-DD."),
    endDate: z.string().describe("Inclusive YYYY-MM-DD."),
    lat: z.number(),
    lon: z.number(),
    label: z.string(),
  })
  .meta({
    id: "EnvironmentTravelLocation",
    description:
      "One manual travel override. Overlapping ranges are accepted — nothing on this surface refuses them.",
  });

const environmentOverview = z
  .object({
    home: environmentHome
      .nullable()
      .describe("Null until a home has been set."),
    travel: z
      .array(environmentTravel)
      .describe("Every stored override, newest start date first."),
    context: z.object({
      days: z
        .number()
        .int()
        .describe("Stored daily observations for this account."),
      latestDate: z
        .string()
        .nullable()
        .describe("Day key of the newest stored observation."),
      latestFetchedAt: z.iso.datetime({ offset: true }).nullable(),
    }),
    lastFetchFailure: z
      .object({
        lastFailedAt: z.iso
          .datetime({ offset: true })
          .describe("When the newest exhausted-retry failure gave up."),
        failures: z
          .number()
          .int()
          .describe(
            "Failures for this account on the queue inside the window.",
          ),
      })
      .nullable()
      .describe(
        "Non-null when the background fetch has been failing, so a `days: 0` count is never left to stand alone as if it meant 'nothing to see'. Deliberately carries no error text: the operator's message can name internals. Also null when there is no queue to ask at all — absence of a queue is not a failing queue.",
      ),
    attribution: z
      .string()
      .describe(
        "Upstream attribution string. Display it wherever the observations are shown.",
      ),
    airQuality: z
      .object({
        enabled: z
          .boolean()
          .describe(
            "The account's switch (`PATCH /api/environment/preferences`).",
          ),
        operatorDisabled: z
          .boolean()
          .describe(
            "True when the operator turned air quality off for the instance; the account switch then has no effect.",
          ),
        days: z
          .number()
          .int()
          .describe(
            "Stored days the air-quality feed returned hourly values for.",
          ),
        latestDate: z
          .string()
          .nullable()
          .describe("Newest such day (YYYY-MM-DD)."),
        domain: z
          .string()
          .nullable()
          .describe(
            "The model domain of that day: `cams_europe` (about 11 km, with pollen) or `cams_global` (about 45 km, no pollen).",
          ),
      })
      .describe("v1.42 — the air-quality part of the module."),
    latestDay: z
      .object({
        date: z.string().describe("YYYY-MM-DD of the newest stored day."),
        tempMin: z.number().nullable(),
        tempMax: z.number().nullable(),
        apparentMax: z
          .number()
          .nullable()
          .describe("Daily feels-like maximum, °C."),
        airQuality: z
          .object({
            pm25Mean: z
              .number()
              .nullable()
              .describe("PM2.5 daily mean, µg/m³."),
            pm10Mean: z.number().nullable().describe("PM10 daily mean, µg/m³."),
            no2Mean: z.number().nullable().describe("NO2 daily mean, µg/m³."),
            o3Max8h: z
              .number()
              .nullable()
              .describe("Ozone, highest 8-hour running mean, µg/m³."),
            eaqiMax: z
              .number()
              .nullable()
              .describe("European air-quality index, daily maximum."),
            uvIndexMax: z.number().nullable(),
            dustMax: z.number().nullable().describe("Dust, µg/m³."),
            pollen: z
              .object({
                alder: z.number().nullable(),
                birch: z.number().nullable(),
                grass: z.number().nullable(),
                mugwort: z.number().nullable(),
                olive: z.number().nullable(),
                ragweed: z.number().nullable(),
              })
              .describe(
                "Daily maxima, grains/m³; null where not covered (outside Europe, before mid 2022).",
              ),
          })
          .nullable()
          .describe(
            "Null while air quality is off for the account or the instance, and for a day whose air-quality part was not fetched yet. Null values inside mean not covered, never zero.",
          ),
      })
      .nullable()
      .describe(
        "v1.42 — the newest stored day, usually yesterday or the day before (the archive settles late). No forecast. Null when nothing is stored.",
      ),
    attributions: z
      .array(z.string())
      .describe(
        "v1.42 — every attribution line, weather first; the air-quality lines (Open-Meteo, Copernicus) while air quality is on. Display them wherever the values are shown.",
      ),
  })
  .meta({
    id: "EnvironmentOverview",
    description:
      "The module overview: home, travel overrides, a count of stored observations, and whether the background fetch is healthy.",
  });

const geocodeResult = z
  .object({
    lat: z.number().describe("Coarse latitude, rounded to 1 decimal."),
    lon: z.number().describe("Coarse longitude, rounded to 1 decimal."),
    label: z
      .string()
      .describe(
        'Assembled from name, region and country, e.g. "City, Region, Country".',
      ),
    timezone: z
      .string()
      .describe(
        'IANA zone for the place, or the literal `"auto"` when the upstream feed reported none.',
      ),
  })
  .meta({ id: "EnvironmentGeocodeResult" });

// v1.42 (#615) — the per-user environment switches.
const environmentPreferencesRequest = z
  .object({
    airQualityEnabled: z
      .boolean()
      .describe("Fetch and show air quality, pollen and UV for this account."),
  })
  .strict()
  .meta({ id: "EnvironmentPreferencesRequest" });

const environmentPreferences = z
  .object({
    airQualityEnabled: z.boolean(),
    operatorDisabled: z
      .boolean()
      .describe(
        "True when the operator turned air quality off for the whole instance; the account switch then has no effect.",
      ),
  })
  .meta({ id: "EnvironmentPreferences" });

export const environmentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/environment/preferences": {
    patch: {
      tags: ["Environment"],
      summary: "Change the environment switches",
      description:
        "Turns the air-quality part of the module on or off for this account (on by default). Off means the nightly fetch skips the air-quality feed, and the overview, the Coach, MCP and the correlations leave the air-quality values out; days already stored keep theirs. Turning it on queues a refresh, and the nightly gap fill catches up on older days. Module-gated. Strict body: an unknown key is a 422.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: environmentPreferencesRequest },
        },
      },
      responses: {
        "200": {
          description: "The stored switches.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                environmentPreferences,
                "EnvironmentPreferencesEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/environment": {
    get: {
      tags: ["Environment"],
      summary: "Read the environmental-context overview",
      description:
        "The account's home location, its travel overrides, how many daily observations are stored, and whether the background fetch has been failing. Module-gated. Not delegable — this is the caller's own configuration.",
      responses: {
        "200": {
          description: "The module overview.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                environmentOverview,
                "EnvironmentOverviewEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
  "/api/environment/home": {
    put: {
      tags: ["Environment"],
      summary: "Set the coarse home location",
      description:
        "Stores the picked city and stamps the effective-from instant. Coordinates are rounded to 1 decimal (about 11 km) server-side regardless of what was sent.\n\nRe-stamping is the part worth knowing: EVERY write moves `since` to now, including one that changes only the label. Days before the new `since` stop resolving against this home, so a correction to an existing home un-attributes the history that home used to cover.\n\nOn success a lookback fetch is enqueued so recent days populate without waiting for the nightly tick. That enqueue is best-effort — it no-ops cleanly when no worker is bound and the response is a 200 either way.\n\nBody cap 4 KiB. Module-gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: homeLocationRequest } },
      },
      responses: {
        "200": {
          description: "The stored home, echoed back with its coarse values.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ home: environmentHome }),
                "EnvironmentHomeEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        "413": {
          description: "Body exceeds 4 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Validation failed; `meta.errorCode` = `environment.invalid`, with every issue listed. An out-of-range coordinate, an empty or over-long label, an unknown key, or a `timezone` the runtime IANA set does not recognise all land here.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/environment/backfill": {
    post: {
      tags: ["Environment"],
      summary: "Enqueue a historical environment fetch",
      description: `Asks the worker to fetch and store past days rather than waiting for the rolling nightly lookback. Returns 202 — the work has been QUEUED, not done; poll \`GET /api/environment\` and watch \`context.days\`.\n\nAn omitted bound defaults to the conservative \`[homeSince .. today]\` range. An explicit start earlier than \`homeSince\` is accepted and then resolves to a skip inside the worker: the span cannot fabricate weather for the pre-home past, so a wide range can legitimately return \`enqueued: true\` and add no days at all.\n\nThe span is capped at ${ENVIRONMENT_MAX_BACKFILL_DAYS} days, and the worker re-checks the cap independently. Body cap 4 KiB. Module-gated, and it draws on the shared analytics-read rate bucket.`,
      requestBody: {
        required: true,
        content: { "application/json": { schema: backfillRequest } },
      },
      responses: {
        "202": {
          description:
            "Accepted and queued. `enqueued` is false when no worker is bound to take it — the request still succeeded, nothing will run.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({
                  enqueued: z.boolean(),
                  startDate: z
                    .string()
                    .describe("The resolved start, after defaulting."),
                  endDate: z
                    .string()
                    .describe("The resolved end, after defaulting."),
                  spanDays: z.number().int(),
                }),
                "EnvironmentBackfillEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        "409": {
          description:
            "No home location is set, so there is nothing to resolve the days against. `meta.errorCode` = `environment.no_home`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "413": {
          description: "Body exceeds 4 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Validation failed. `meta.errorCode` = `environment.invalid` for a malformed body, an unknown key or a start after the end; `environment.range_too_large` when the resolved span exceeds the day cap.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/environment/geocode": {
    get: {
      tags: ["Environment"],
      summary: "Search a place for the home-location picker",
      description:
        "Forward-geocodes free text to at most five coarse matches. The lookup runs server-side on purpose: the browser never talks to the upstream host, so the CSP needs no third-party entry.\n\nA failed or empty upstream answer is `results: []`, not an error — the picker shows 'no match' rather than a broken state, and the caller cannot distinguish 'nothing matched' from 'the feed was unreachable'.\n\nModule-gated, and it draws on the shared analytics-read rate bucket so a runaway autocomplete loop is capped.",
      requestParams: { query: geocodeQuery },
      responses: {
        "200": {
          description: "Matches, possibly empty.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ results: z.array(geocodeResult) }),
                "EnvironmentGeocodeEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
        "422": {
          description:
            "`q` was missing, empty after trimming, or longer than 120 characters. `meta.errorCode` = `environment.invalid`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/environment/travel": {
    post: {
      tags: ["Environment"],
      summary: "Add a travel override",
      description:
        "Declares that the account was somewhere other than home for an inclusive date range; the days it covers resolve against this location instead. Coordinates are rounded to 1 decimal (about 11 km) server-side.\n\nAdding one enqueues a refresh over exactly the declared window so its days re-resolve. Nothing checks for overlap with an existing override — two ranges covering the same day are accepted, and the worker picks between them.\n\nBody cap 4 KiB. Module-gated.",
      requestBody: {
        required: true,
        content: { "application/json": { schema: travelLocationRequest } },
      },
      responses: {
        "201": {
          description: "The stored override.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                environmentTravel,
                "CreateEnvironmentTravelEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        "413": {
          description: "Body exceeds 4 KiB.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        "415": {
          description: "`Content-Type` is not `application/json`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
        "422": {
          description:
            "Validation failed; `meta.errorCode` = `environment.invalid`. Covers an out-of-range coordinate, a malformed date, an unknown key, and `startDate` after `endDate`.",
          content: { "application/json": { schema: errorEnvelope } },
        },
      },
    },
  },
  "/api/environment/travel/{id}": {
    delete: {
      tags: ["Environment"],
      summary: "Remove a travel override",
      description:
        "Owner-scoped: the delete matches on the id AND the caller's user id, so one account can never remove another's override — a cross-account id is a 404, same as one that never existed.\n\nHard delete, not a tombstone, and NOT idempotent in the usual sense: a second delete of the same id answers 404 rather than 200.\n\nRemoving an override does NOT re-resolve the days it used to cover; they keep whatever weather was stored for them until a backfill is asked for. Module-gated.",
      requestParams: {
        path: z.object({ id: z.string().describe("Travel-override id.") }),
      },
      responses: {
        "200": {
          description: "Removed.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                z.object({ deleted: z.boolean() }),
                "DeleteEnvironmentTravelEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        "404": {
          description:
            "No such override for this account. `meta.errorCode` = `environment.travel.not_found`. Also the answer for an id owned by somebody else — existence is not leaked.",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
