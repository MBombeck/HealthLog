import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  readLogBuffer,
  LOG_BUFFER_MAX,
  PROBLEMS_BUFFER_MAX,
} from "@/lib/logging/in-memory-buffer";
import { redactSecrets } from "@/lib/logging/redact";
import type { WideEvent } from "@/lib/logging/types";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { isoDateTime } from "@/lib/validations/datetime";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  // The error id a person reads out is the first 8 characters of the request
  // id; the full id (up to 64) matches as well. Same alphabet as an accepted
  // incoming `x-request-id`.
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{8,64}$/)
    .optional(),
  ring: z.enum(["all", "problems"]).default("all"),
  traceId: z.string().trim().min(1).max(200).optional(),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  since: isoDateTime({ offset: false }).optional(),
  until: isoDateTime({ offset: false }).optional(),
  limit: z.coerce.number().int().min(1).max(PROBLEMS_BUFFER_MAX).default(200),
});

/**
 * Admin endpoint: tail of the per-process in-memory wide-event ring buffer.
 *
 * `ring=problems` reads the second ring, which keeps the last 1,000 `warn` and
 * `error` events only, so a failure a person reported an hour ago is still
 * there after the main ring has turned over. `requestId` finds the event
 * behind an error id by prefix.
 *
 * The buffer is populated by `transports.emitEvent()` so the result mirrors
 * what would be shipped to Loki (sampler-gated). Per-process and volatile —
 * see `src/lib/logging/in-memory-buffer.ts` for the limitations.
 *
 * Privacy: every event is run through `redactSecrets()` before egress so a
 * stray Bearer / hlk_ / sk- token in an `error.message` never reaches the
 * admin UI. Storage stays raw to keep diagnostics intact when shipped to
 * Loki, but the egress path here is the user-facing one.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.app-logs.list" } });

  const { searchParams } = new URL(request.url);
  const result = querySchema.safeParse({
    requestId: searchParams.get("requestId") ?? undefined,
    ring: searchParams.get("ring") ?? undefined,
    traceId: searchParams.get("traceId") ?? undefined,
    level: searchParams.get("level") ?? undefined,
    action: searchParams.get("action") ?? undefined,
    since: searchParams.get("since") ?? undefined,
    until: searchParams.get("until") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });
  if (!result.success) return returnAllZodIssues(result.error);
  const parsed = result.data;

  const events = readLogBuffer({
    ring: parsed.ring,
    requestId: parsed.requestId,
    traceId: parsed.traceId,
    level: parsed.level,
    action: parsed.action,
    since: parsed.since ? new Date(parsed.since) : undefined,
    until: parsed.until ? new Date(parsed.until) : undefined,
    limit: parsed.limit,
  });

  const redacted = events.map(redactEventForEgress);

  return apiSuccess({
    events: redacted,
    meta: {
      total: redacted.length,
      bufferMax: LOG_BUFFER_MAX,
      problemsBufferMax: PROBLEMS_BUFFER_MAX,
      ring: parsed.ring,
    },
  });
});

/**
 * Recursively walk a JSON-shaped value and run `redactSecrets()` on every
 * string. Used by `redactEventForEgress` to scrub the open-shape `meta`
 * and `action.details` blobs — those carry annotated key=value pairs from
 * `annotate()` calls (e.g. provider-runner's `ai_chain_hop_<n>_reason`
 * which captures the upstream error body capped at 240 chars). If an
 * upstream provider ever echoes a Bearer token in its error body, the
 * raw token would land in `meta` without this scrub.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

/**
 * Apply `redactSecrets()` to every string-shaped field that could carry a
 * leaked credential. Keeps the structure intact so the UI can still render
 * the JSON tree.
 */
function redactEventForEgress(event: WideEvent): WideEvent {
  // structuredClone keeps us from mutating the live buffer entry.
  const out = structuredClone(event);
  if (out.error?.message) {
    out.error.message = redactSecrets(out.error.message);
  }
  if (out.error?.stack) {
    out.error.stack = redactSecrets(out.error.stack);
  }
  if (out.warnings?.length) {
    out.warnings = out.warnings.map((w) => redactSecrets(w));
  }
  if (out.http?.user_agent) {
    // UA strings are public, but a misbehaving client could shove a token
    // into one. Cheap to redact, free to keep correct.
    out.http.user_agent = redactSecrets(out.http.user_agent);
  }
  if (out.external_calls?.length) {
    out.external_calls = out.external_calls.map((c) => ({
      ...c,
      error: c.error ? redactSecrets(c.error) : c.error,
    }));
  }
  if (out.meta) {
    out.meta = redactDeep(out.meta) as Record<string, unknown>;
  }
  if (out.action?.details) {
    out.action.details = redactDeep(out.action.details) as Record<
      string,
      unknown
    >;
  }
  return out;
}
