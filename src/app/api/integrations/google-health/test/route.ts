import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { getValidToken } from "@/lib/google-health/sync-core";
import {
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE,
  GOOGLE_HEALTH_API_BASE,
  GOOGLE_HEALTH_DATA_TYPES,
  fetchDailyRollUp,
  fetchDataPoints,
} from "@/lib/google-health/client";
import { GoogleHealthApiError } from "@/lib/google-health/response-classifier";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";

export const dynamic = "force-dynamic";

// Cheap authenticated probe — the single (non-paginated) profile endpoint the
// Google Health client already calls via `fetchProfile`.
// Base from `src/lib/google-health/client.ts` (`GOOGLE_HEALTH_API_BASE`).
const GOOGLE_HEALTH_PROFILE_URL = `${GOOGLE_HEALTH_API_BASE}/users/me/profile`;
const TIMEOUT_MS = 5_000;

type CategorisedError = { code: string; message: string };

function categoriseHttpStatus(status: number): CategorisedError {
  if (status === 401 || status === 403) {
    return {
      code: "credentials_rejected",
      message: "Google Health rejected the credentials",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      message: "Google Health rate-limited the request",
    };
  }
  if (status >= 500) {
    return {
      code: "upstream_error",
      message: "Google Health returned a server error",
    };
  }
  return {
    code: "connection_failed",
    message: "Google Health connection failed",
  };
}

/**
 * Reduce an arbitrary JSON value to its STRUCTURE: object keys survive, every
 * leaf collapses to its `typeof` label (`"string"`, `"number"`, …; null →
 * `"null"`), arrays keep only their first element's structure. No health value,
 * timestamp, or identifier survives — the output is safe for a self-hoster to
 * paste into a public diagnostics thread.
 */
function describeStructure(v: unknown, depth = 0): unknown {
  if (depth > 8) return "…";
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return v.length > 0 ? [describeStructure(v[0], depth + 1)] : [];
  }
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        describeStructure(val, depth + 1),
      ]),
    );
  }
  return typeof v;
}

type ProbeResult =
  | {
      ok: true;
      count: number;
      structure: unknown;
      /**
       * Rollup types: which documented dailyRollUp request shape Google
       * accepted (`days90` standard chunking vs `days14` conservative
       * fallback). Daily-summary types: which `.date` filter prefix style
       * Google accepted (`camel` worked-example vs `snake` fallback) — the
       * live verdict on the docs' self-contradiction.
       */
      requestShape?: string;
    }
  | {
      ok: false;
      httpStatus: number | null;
      classification: string | null;
      detail: string | null;
    };

/**
 * Fetch ONE recent page/window per data type and reduce the first data point to
 * its structure. Errors are captured per type (a 400's AIP-193 detail included)
 * so a broken type doesn't hide the others — that per-type verdict is the whole
 * point of the probe.
 */
async function runStructureProbe(
  accessToken: string,
  tz: string | undefined,
): Promise<Record<string, ProbeResult>> {
  const now = Date.now();
  const listStart = new Date(now - 14 * 24 * 60 * 60 * 1000);
  const rollupStart = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const results: Record<string, ProbeResult> = {};
  for (const [name, dataType] of Object.entries(GOOGLE_HEALTH_DATA_TYPES)) {
    try {
      let points: Record<string, unknown>[];
      let requestShape: string | undefined;
      let envelopeKeys: string[] | undefined;
      if (dataType.timeField === "rollup") {
        // One minimal dailyRollUp exercise per rollup type (7-day range) — the
        // probe reports the response skeleton AND which documented request
        // shape Google accepted, so a live account settles the range-constraint
        // question from the UI.
        points = await fetchDailyRollUp(
          dataType,
          accessToken,
          `probe:${name}`,
          {
            start: rollupStart,
            tz,
            onShape: (shape) => {
              requestShape = shape;
            },
            // Raw envelope key names of the first page (names only). When the
            // parse yields zero points this is the one signal that separates
            // "the service returned nothing" from "the service returned points
            // under a key this reader does not know" — per-cohort naming drift.
            onEnvelopeKeys: (keys) => {
              envelopeKeys = keys;
            },
          },
        );
      } else {
        const pageSize =
          dataType.timeField === "sessionEnd" ||
          dataType.timeField === "civilStart"
            ? GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE
            : 5;
        points = await fetchDataPoints(dataType, accessToken, `probe:${name}`, {
          start: listStart,
          pageSize,
          maxPages: 1,
          tz,
          // Daily-summary types report which `.date` filter prefix style
          // Google accepted, so a live account settles the docs' conflict.
          onDateFilterStyle: (style) => {
            requestShape = style;
          },
        });
      }
      results[name] = {
        ok: true,
        count: points.length,
        structure: points.length > 0 ? describeStructure(points[0]) : null,
        ...(requestShape ? { requestShape } : {}),
        // Only meaningful when the parse came back empty — a populated parse
        // proves the envelope key already matches.
        ...(points.length === 0 && envelopeKeys ? { envelopeKeys } : {}),
      };
    } catch (e) {
      results[name] =
        e instanceof GoogleHealthApiError
          ? {
              ok: false,
              httpStatus: e.httpStatus ?? null,
              classification: e.classification,
              detail: e.upstreamError ?? null,
            }
          : {
              ok: false,
              httpStatus: null,
              classification: null,
              detail: "fetch_failed",
            };
    }
  }
  return results;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "integrations.google-health.test" } });

  const rl = await checkRateLimit(`google-health-test:${user.id}`, 5, 60_000);
  if (!rl.allowed) {
    return apiError("Too many test requests", 429, {
      errorCode: "rate_limited_self",
    });
  }

  // Flag-only payload — `{ "probe": "structure" }` switches to the per-type
  // structure probe; anything else runs the plain connection check. Cap the
  // parse cost (mirrors safeJson maxBytes).
  let structureProbe = false;
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    structureProbe = body?.probe === "structure";
  } catch {
    // no body provided -> plain connection check
  }

  const tokenInfo = await getValidToken(user.id);
  if (!tokenInfo) {
    return apiError("Google Health not connected", 422, {
      errorCode: "not_configured",
    });
  }

  if (structureProbe) {
    // Per-data-type structure probe: one page/window per type, reduced to field
    // names + leaf types (never values) so a self-hoster can paste the output
    // as diagnostics without leaking a single reading.
    annotate({
      action: { name: "integrations.google-health.structure_probe" },
    });
    const tz = await resolveUserTimezone(user.id);
    const types = await runStructureProbe(tokenInfo.accessToken, tz);
    return apiSuccess({
      probe: "structure",
      probedAt: new Date().toISOString(),
      types,
    });
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId: user.id },
    select: { lastSyncedAt: true },
  });

  const start = performance.now();

  try {
    const res = await safeFetch(
      GOOGLE_HEALTH_PROFILE_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenInfo.accessToken}`,
        },
      },
      { timeoutMs: TIMEOUT_MS },
    );
    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const cat = categoriseHttpStatus(res.status);
      annotate({
        meta: {
          google_health_test_status: res.status,
          google_health_test_code: cat.code,
          google_health_test_latency_ms: latencyMs,
        },
      });
      return apiError(cat.message, 502, { errorCode: cat.code });
    }

    return apiSuccess({
      ok: true,
      lastSyncedAt: connection?.lastSyncedAt ?? null,
      latencyMs,
    });
  } catch (e) {
    const err = e as Error;
    // safeFetch wraps timeouts into SafeFetchError{kind:"timeout"};
    // legacy AbortError name is preserved for compatibility with any
    // future direct-fetch path that still reaches this catch.
    const isAbort =
      (e instanceof SafeFetchError && e.kind === "timeout") ||
      err.name === "AbortError";
    const code = isAbort ? "timeout" : "connection_failed";
    annotate({
      meta: {
        google_health_test_code: code,
        google_health_test_error: redact(err.message).slice(0, 300),
      },
    });
    return apiError(
      isAbort
        ? "Google Health request timed out"
        : "Google Health connection failed",
      502,
      { errorCode: code },
    );
  }
});

// Strip any `Bearer <token>` substring before annotating; the catch path can
// see DNS / TLS errors that include the request init via err.cause in some
// runtimes, and we never want a token in Loki.
function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
