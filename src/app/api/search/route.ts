/**
 * `POST /api/search` with `{ q, limit }` — one search over the record
 * (Discussion #1117):
 * visits and procedures, conditions, documents (title and indexed text),
 * vaccinations, lab results, medications, symptoms, workouts and the notes on
 * mood entries, readings and illness days. Each hit carries the in-app path
 * that opens it. The work is `searchRecords` in `src/lib/search/`.
 *
 * Admission declares the whole record, like the timeline: the search lays
 * every section side by side, so a grant scoped to some of them does not open
 * it. The sources are narrowed to the grant's sections all the same
 * (`actingDomainVisibility`), and to the record's module switches, so a
 * switched-off module is not read at all.
 *
 * The query is health data ("Schulter", a drug, a diagnosis). It never
 * reaches a log: it travels in the JSON body rather than the URL, so neither
 * this app's request log nor a reverse proxy's access log records it; the
 * annotation carries its length and the counts only, and a refused query is
 * answered without echoing it.
 *
 * Bounded per actor: 20 searches a minute (the palette asks once per pause in
 * typing, and a manager searching someone's record spends their own
 * allowance), and one at a time. A newer search by the same actor aborts the
 * one before it, and a client that goes away aborts its own, so an abandoned
 * search stops reading at its next budget check instead of running out its
 * time (`in-flight.ts`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { beginSearch, SUPERSEDED } from "@/lib/search/in-flight";
import { searchRecords } from "@/lib/search/search-records";
import { searchQuerySchema } from "@/lib/search/wire-schemas";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Searches per actor per minute: one per pause in typing, with room to spare. */
const SEARCH_RATE_LIMIT = 20;
const SEARCH_RATE_WINDOW_MS = 60_000;
/** The body is a query of at most 100 characters and a number. */
const SEARCH_BODY_MAX_BYTES = 2048;

function displayLocale(value: string | null | undefined): Locale {
  return locales.includes(value as Locale) ? (value as Locale) : defaultLocale;
}

export const POST = apiHandler(async (request: NextRequest) => {
  // A POST that only reads: the query rides the body to stay out of URLs, and
  // a read grant on the whole record is what it needs, as it was over GET.
  const { user, actor, grantId } = await requireRecordAuth("read", "record", {
    readOverPost: true,
  });

  const rl = await checkRateLimit(
    `search:${actor.id}`,
    SEARCH_RATE_LIMIT,
    SEARCH_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many searches. Please retry shortly.", 429);
  }

  const parsed = await parseJsonBody(request, searchQuerySchema, {
    maxBytes: SEARCH_BODY_MAX_BYTES,
    input: (raw) => {
      const body = raw as { q?: unknown; limit?: unknown };
      return {
        q: body?.q ?? undefined,
        limit: body?.limit ?? undefined,
      };
    },
    action: "search.query.invalid",
    countIssues: true,
    errorCode: "search.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const slot = beginSearch(actor.id, user.id);
  try {
    const [modules, domainVisible, timezone] = await Promise.all([
      resolveModuleMap(user.id),
      actingDomainVisibility(prisma, grantId),
      resolveUserTimezone(user.id),
    ]);
    const result = await searchRecords({
      recordId: user.id,
      query: parsed.data.q,
      limit: parsed.data.limit,
      modules,
      domainVisible,
      displayLocale: displayLocale(actor.locale),
      timezone,
      signal: AbortSignal.any([request.signal, slot.signal]),
    });

    if (slot.signal.aborted) {
      // A newer search by the same actor took over; this answer is partial
      // and nobody is waiting for it.
      annotate({
        action: { name: "search.query.superseded" },
        meta: { query_length: parsed.data.q.length },
      });
      return apiError("A newer search replaced this one", 409, {
        errorCode: SUPERSEDED,
      });
    }

    annotate({
      action: { name: "search.query.run" },
      meta: {
        query_length: parsed.data.q.length,
        limit: parsed.data.limit,
        sources: result.stats.sources,
        rows_scanned: result.stats.rows,
        matches: result.stats.candidates,
        groups: result.groups.length,
        hits: result.groups.reduce((n, g) => n + g.hits.length, 0),
        truncated: result.truncated,
        elapsed_ms: result.stats.elapsedMs,
        delegated: grantId !== null,
        aborted: request.signal.aborted,
      },
    });
    return apiSuccess({ groups: result.groups, truncated: result.truncated });
  } finally {
    slot.end();
  }
});
