"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pollAttemptCount } from "@/lib/queries/refetch-interval";
import type { InsightResult } from "@/lib/ai/types";
// Type-only — the runtime schemas load lazily inside `fetchAdvisor` so
// the zod module graph (`@/lib/ai/schema` is ~550 lines of zod builders)
// stays out of the insights route-entry chunk. This hook is imported
// eagerly by BOTH the insights page and the layout shell, so a value
// import here landed zod in the chunk every insights visit downloads
// before first paint; the schemas are only needed once a payload has
// actually arrived, which is by definition after the network hop.
import type {
  DailyBriefing as DailyBriefingPayload,
  TrendAnnotations,
} from "@/lib/ai/schema";
import { queryKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useAiCapability, useAiProviderState } from "@/hooks/use-ai-capability";
import { AI_BUDGETS, COMPREHENSIVE_MODEL_CALLS } from "@/lib/ai/ai-budgets";
import { clientAbortMs } from "@/lib/ai/effective-timeout";
import type { BriefingFailureClass } from "@/lib/insights/briefing-failure-marker";

/**
 * v1.4.16 (CRITICAL C1 + C2) — shared TanStack Query
 * helper that reads the rich advisor payload from `/api/insights/generate`.
 *
 * Why a POST under a `useQuery` rather than a dedicated GET endpoint:
 * the route already cache-returns the most recent generation (24h TTL on
 * `User.insightsCachedAt` / `User.insightsCachedTextEncrypted`) without burning a
 * rate-limit token, so a single POST-without-`force` is functionally a
 * GET-or-generate. Adding a separate GET would duplicate the cache-read
 * branch and split the audit-log surface; the reconcile report deferred
 * C1+C2 specifically because it assumed that duplication was required,
 * but the route already supports the cache-aware path.
 *
 * Every surface that mounts the query under the same key shares the
 * cache, so a regenerate from one surface refreshes the others without
 * a second LLM call.
 */
export interface InsightAdvisorPayload {
  insights: InsightResult;
  cached: boolean;
  cachedAt?: string | null;
  legacyPayload?: boolean;
  /**
   * v1.4.20 — Daily Briefing block surfaced for the new hero
   * strip + briefing card. Lives on the cached payload alongside the
   * legacy `insights` shape (see `aiInsightResponseSchema` — the
   * `.passthrough()` lets the field round-trip through any provider).
   * Validated client-side via the schema's `safeParse` to keep a
   * malformed payload from poisoning the briefing card.
   */
  dailyBriefing?: DailyBriefingPayload | null;
  /**
   * v1.4.20 — optional trend annotations for the Trends row.
   * Same lift-pattern as `dailyBriefing` — validated client-side and
   * left null when the cached payload predates PROMPT_VERSION 4.20.1.
   */
  trendAnnotations?: TrendAnnotations | null;
  /**
   * v1.16.7 — true when the GET served a stale / missing briefing AND
   * enqueued an out-of-band warm. The query polls (bounded) while this
   * is set so the fresh briefing reaches the open page in-session
   * instead of waiting for the next mount.
   */
  revalidating?: boolean;
  /**
   * v1.18.9 (#4) — false when no AI provider is configured anywhere. The
   * read path serves the last cached briefing regardless (no provider is
   * needed to READ the cache), so a provider-less account keeps seeing a
   * days-old briefing presented as current. When this is false the
   * surfaces pair the briefing's honest relative age with a discreet
   * "connect a provider" affordance. Undefined on a cached payload that
   * predates the field — treated as "provider present" (no hint).
   */
  hasProvider?: boolean;
  /**
   * v1.25 — true when the most recent generation attempt failed (a failure
   * marker newer than the last successful generation). The briefing keeps its
   * last good text on failure, so this is the honest signal that a shown
   * briefing is held, or — with no last good text — that the empty state
   * should read "couldn't generate" with a retry rather than the generic one.
   * Absent on a pre-field cached payload → treated as "not failed" (no hint).
   */
  generationFailed?: boolean;
  /**
   * v1.25.3 — coarse class of the most recent failure (`timeout`, `auth`,
   * `rate-limit`, `provider`, `format`, `unknown`), so the empty state can
   * point its hint at the right lever. Null / absent → no specific hint, the
   * generic failed-description holds.
   */
  generationFailureClass?: BriefingFailureClass | null;
  /**
   * v1.28.28 (#470) — set by the POST when the number-grounding gate stripped
   * the freshly generated briefing (after its one corrective retry). Without
   * it the 200 carried a silently-null briefing and the card's "no briefing
   * yet" made the regenerate button read as doing nothing.
   *
   * v1.28.30 — also carried by the read-only GET, backed by a dated
   * server-side marker: a briefing the nightly warm stripped now renders
   * the same honest "withheld" state on every read until the next
   * successful generation, not only on the regenerate response.
   */
  briefingOmittedReason?: "ungrounded" | null;
}

/**
 * v1.4.31 — bound the advisor READ (GET) with an 8-second
 * `AbortController` so a cache-miss path (server still warming out of
 * band) does not pin the mother-page main thread. The strip stays
 * interactive in the DOM; dropping the worst case from 30 s to 8 s
 * eliminates the mobile-tap-block window per
 * `.planning/research/v15-insights-blocking-bug.md` fix 1.
 */
const ADVISOR_TIMEOUT_MS = 8_000;

/**
 * v1.15.18 — the user-initiated regenerate (`force`) POSTs an INLINE
 * generation that routinely runs longer than the 8 s read budget; bounding it
 * at 8 s discarded a slow-but-successful generation.
 *
 * #1267 — the budget follows the person's response-timeout setting instead of
 * a constant 45 s, which cut every regenerate on a slow local model while the
 * server still had minutes left. The route makes up to two sequential model
 * calls (the generation and its grounding retry), and a reasoning model that
 * answered nothing is asked once more inside the first, so three calls at the
 * per-call timeout, at least the briefing's own 180 s default each. Never
 * shorter than the server: the abort is only for a request nobody answers.
 *
 * Fewer than `COMPREHENSIVE_MODEL_CALLS` on purpose: the route runs its own
 * pipeline (`src/lib/insights/briefing-request/`), not the background
 * generator, and answers an unparseable reply or a screened payload with a
 * refusal instead of the generator's JSON retry and screen repair.
 * `ai-call-timeout-guard.test.ts` holds that pipeline to these two stages.
 */
const FORCE_ADVISOR_MODEL_CALLS = 3;

/** The client budget for a forced regenerate (exported for the test). */
export function forceAdvisorTimeoutMs(
  responseTimeoutMs: number | null | undefined,
): number {
  return clientAbortMs(
    responseTimeoutMs,
    FORCE_ADVISOR_MODEL_CALLS,
    AI_BUDGETS.comprehensive.timeoutMs,
  );
}

/**
 * v1.16.7 — poll cadence + ceiling while the server reports
 * `revalidating: true` (stale briefing served, out-of-band warm in
 * flight). The query's 1 h `staleTime` plus the app-default
 * `refetchOnWindowFocus: false` means a stale-served briefing would
 * otherwise never refresh in-session. The attempt ceiling stops a
 * persistently failing generation from polling an open page forever.
 * Same bounded-poll shape as `nextStatusPollInterval`
 * (`src/hooks/use-insight-status.ts`).
 *
 * `ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS` is the ceiling for a settling
 * regenerate and for callers whose poll waits on no model; the briefing read
 * itself waits as long as the warm may run (`advisorRevalidatePollMaxAttempts`).
 */
export const ADVISOR_REVALIDATE_POLL_MS = 25_000;
export const ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS = 10;

/**
 * The attempt ceiling for the briefing read while the warm is in flight.
 *
 * #1274 — a fixed ten attempts stopped watching after 225 s, while the warm
 * the read enqueued may run for the person's response timeout on each of the
 * generation's sequential calls (`COMPREHENSIVE_MODEL_CALLS`). A local model
 * needing 300 s per answer delivered its briefing to a page that had stopped
 * looking, which kept the empty or the previous failure state on screen. The
 * window is the warm's own bound read off the published setting, never less
 * per call than the briefing's 180 s default (`clientAbortMs`), plus the first
 * read and one interval for the queue to pick the warm up.
 */
export function advisorRevalidatePollMaxAttempts(
  responseTimeoutMs: number | null | undefined,
): number {
  const warmMs = clientAbortMs(
    responseTimeoutMs,
    COMPREHENSIVE_MODEL_CALLS,
    AI_BUDGETS.comprehensive.timeoutMs,
  );
  return Math.ceil(warmMs / ADVISOR_REVALIDATE_POLL_MS) + 2;
}

/**
 * Refs #786 — the settling state a timed-out force regenerate enters.
 *
 * Async-truth contract, client end (the server end is documented at the head
 * of `src/app/api/insights/generate/route.ts`): the force POST generates
 * INLINE and keeps running after the client aborts — the server
 * usually writes the fresh cache moments later. A page that knows work is
 * running must keep saying so until it can prove an outcome, so the timeout
 * is NOT surfaced as an error. Instead the hook remembers the baseline it was
 * showing and polls (bounded, same cadence as the revalidating poll) until it
 * can prove one of three outcomes: the cache advanced past the baseline
 * (fresh), a failure marker newer than the baseline appeared (settle-failed),
 * or the attempt cap ran out (settle-failed — never wait forever).
 */
export interface AdvisorSettleState {
  /** `cachedAt` of the payload shown when the client gave up (null = none). */
  baselineCachedAt: string | null;
  /** Whether a failure marker was ALREADY reported at that time — an
   *  unchanged flag proves nothing about THIS generation. */
  baselineFailed: boolean;
  /** The query's `dataUpdateCount` when settling began; poll attempts count
   *  from here, not from mount. */
  startedAtUpdateCount: number;
}

/** The outcome the falling-edge toast reports for a settled regenerate. */
export type AdvisorRegenerateOutcome = AdvisorFetchOutcome | "settle-failed";

/**
 * Decide what a settling poll result proves. Pure test seam — the effect in
 * `useInsightsAdvisorQuery` applies the returned resolution verbatim.
 * `null` = no evidence yet, keep polling.
 */
export function resolveAdvisorSettle(
  settling: AdvisorSettleState,
  payload:
    | Pick<InsightAdvisorPayload, "cachedAt" | "generationFailed">
    | null
    | undefined,
  dataUpdateCount: number,
): "fresh" | "settle-failed" | null {
  const cachedAt = payload?.cachedAt ?? null;
  if (
    cachedAt != null &&
    (settling.baselineCachedAt == null ||
      new Date(cachedAt).getTime() >
        new Date(settling.baselineCachedAt).getTime())
  ) {
    return "fresh";
  }
  // A failure marker that FLIPPED during settling is the server saying the
  // inline generation died after we stopped watching — an honest error. One
  // that was already set at the baseline predates this attempt and proves
  // nothing; keep waiting for the cache or the cap.
  if ((payload?.generationFailed ?? false) && !settling.baselineFailed) {
    return "settle-failed";
  }
  if (
    dataUpdateCount - settling.startedAtUpdateCount >=
    ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS
  ) {
    return "settle-failed";
  }
  return null;
}

/**
 * Decide whether the advisor query schedules its next poll. Pure so the
 * ceiling + stop conditions are unit-testable: returns the interval
 * while the last payload carries `revalidating: true`, `false` once a
 * response comes back with the flag falsy OR the attempt cap is hit.
 *
 * Refs #786 — settling is the SECOND poll reason: while a timed-out force
 * regenerate awaits its real outcome the query polls regardless of the
 * `revalidating` flag, with attempts counted from the settle start so a
 * long-mounted page gets the full budget.
 */
export function nextAdvisorPollInterval(
  revalidating: boolean | undefined,
  dataUpdateCount: number,
  settling?: Pick<AdvisorSettleState, "startedAtUpdateCount"> | null,
  maxAttempts: number = ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS,
): number | false {
  if (settling) {
    if (
      dataUpdateCount - settling.startedAtUpdateCount >=
      ADVISOR_REVALIDATE_POLL_MAX_ATTEMPTS
    ) {
      return false;
    }
    return ADVISOR_REVALIDATE_POLL_MS;
  }
  if (!revalidating) return false;
  if (dataUpdateCount >= maxAttempts) return false;
  return ADVISOR_REVALIDATE_POLL_MS;
}

/**
 * v1.15.18 — the outcome of a force regenerate, so the UI can be HONEST:
 * only a `fresh` outcome should toast "refreshed". A `timeout` (slow gen
 * the client gave up on) and a `no-provider` (422) are distinct failure
 * modes.
 *
 * v1.15.20 — `rate-limited` (429) splits off from `empty`: the user's
 * regenerate quota is exhausted, which deserves a "try again later"
 * hint rather than the success toast the old lump produced. `empty` now
 * means only the transient 503 surface (provider chain unavailable).
 *
 * `unavailable` (403) is the server refusing the briefing capability: the
 * operator's switch, the person's opt-out, or a consent the chain needs. The
 * web only asks while `/api/auth/me` says the capability is available, so this
 * is the backstop for the moment between a switch flipping and `/me`
 * refreshing. It settles like the other expected refusals instead of
 * throwing, so the briefing card never turns into an error.
 */
export type AdvisorFetchOutcome =
  | "fresh"
  | "empty"
  | "rate-limited"
  | "timeout"
  | "no-provider"
  | "unavailable";

interface AdvisorFetchResult {
  payload: InsightAdvisorPayload | null;
  outcome: AdvisorFetchOutcome;
}

/**
 * Exported as a test seam (like `nextAdvisorPollInterval`): the explicit
 * regenerate MUST post `force: true` — generation happens on the nightly
 * cron and on explicit intent only, and a force-less button silently
 * re-reads the 24 h cache (the "button does nothing" half of the
 * no-briefing-today chain). The wire-contract test pins it.
 */
export async function fetchAdvisor(
  options: {
    force?: boolean;
    /** `ai.provider.responseTimeoutMs` from the account payload. */
    responseTimeoutMs?: number | null;
  } = {},
): Promise<AdvisorFetchResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    options.force
      ? forceAdvisorTimeoutMs(options.responseTimeoutMs)
      : ADVISOR_TIMEOUT_MS,
  );
  let res: Response;
  try {
    // Read path (no `force`): the GET serves the cached briefing read-only
    // and enqueues an out-of-band warm on a stale / missing cache — it
    // never blocks the page-load path on the provider chain. Only the
    // user-initiated regenerate (`force`) POSTs to generate inline.
    // apiFetchRaw: this path branches on raw status codes (422 / 429 /
    // 503 are expected, non-throwing surfaces) — the unwrap helpers
    // would turn them into thrown ApiErrors.
    res = options.force
      ? await apiFetchRaw("/api/insights/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
          signal: controller.signal,
        })
      : await apiFetchRaw("/api/insights/generate", {
          method: "GET",
          signal: controller.signal,
        });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Graceful empty payload — the UI surfaces the empty / regen
      // CTA exactly as it does for the 422 / 429 / 503 paths below.
      // `timeout` lets the regenerate path avoid claiming success.
      return { payload: null, outcome: "timeout" };
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!res.ok) {
    // 422 (no provider configured), 429 (rate-limited), and 503
    // (provider chain unavailable) are expected surfaces — return null
    // so the consuming UI shows the empty / error state without the
    // query slipping into an `isError` retry loop. Each gets its own
    // outcome tag so the regenerate toast can be honest about WHY no
    // fresh payload arrived.
    if (res.status === 422) {
      return { payload: null, outcome: "no-provider" };
    }
    if (res.status === 429) {
      return { payload: null, outcome: "rate-limited" };
    }
    if (res.status === 503) {
      return { payload: null, outcome: "empty" };
    }
    if (res.status === 403) {
      return { payload: null, outcome: "unavailable" };
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const payload = json.data as InsightAdvisorPayload;
  // Lazy schema load — see the type-only import note at the top. The
  // module is cached after the first call, so this await is free from
  // the second fetch on.
  const { dailyBriefingSchema, trendAnnotationsSchema } =
    await import("@/lib/ai/schema");
  // The cached `insights` blob may carry a `dailyBriefing` from a fresh
  // PROMPT_VERSION 4.20.x generation. Lift it onto the payload so
  // consumers don't have to know the legacy shape.
  const briefingCandidate = (payload?.insights as Record<string, unknown>)
    ?.dailyBriefing;
  if (briefingCandidate != null) {
    const parsed = dailyBriefingSchema.safeParse(briefingCandidate);
    if (parsed.success) {
      payload.dailyBriefing = parsed.data;
    } else {
      // Malformed cached briefing — keep null so the UI shows the
      // empty-state CTA instead of a half-rendered card.
      payload.dailyBriefing = null;
    }
  } else {
    payload.dailyBriefing = null;
  }

  // v1.4.20 — same lift for `trendAnnotations`. Cached payloads
  // from the 4.20.0 line predate the field, so null is the expected
  // default. A malformed candidate also resolves to null so the UI
  // surfaces the per-metric empty hint instead of a half-rendered card.
  const annotationsCandidate = (payload?.insights as Record<string, unknown>)
    ?.trendAnnotations;
  if (annotationsCandidate != null) {
    const parsed = trendAnnotationsSchema.safeParse(annotationsCandidate);
    payload.trendAnnotations = parsed.success ? parsed.data : null;
  } else {
    payload.trendAnnotations = null;
  }
  return { payload, outcome: "fresh" };
}

export interface UseInsightsAdvisorResult {
  payload: InsightAdvisorPayload | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  regenerate: () => void;
  isRegenerating: boolean;
  regenerateError: Error | null;
  /**
   * v1.15.18 — the outcome of the LAST settled regenerate. The tab strip
   * fires the "refreshed" toast only when this is `"fresh"`, so a slow gen
   * the client gave up on (`"timeout"`) or a missing provider
   * (`"no-provider"`) never reads as "done".
   *
   * Refs #786 — a timed-out regenerate no longer surfaces `"timeout"` at the
   * spinner edge: the hook keeps `regenerateSettling` true and polls until it
   * can PROVE an outcome, then reports `"fresh"` (cache advanced) or
   * `"settle-failed"` (newer failure marker / attempt cap) here.
   */
  regenerateOutcome: AdvisorRegenerateOutcome | null;
  /**
   * Refs #786 — true while a timed-out force regenerate awaits its real
   * outcome (bounded poll). The strip keeps the button busy and says the
   * assessment is still being prepared; NO toast fires until this falls.
   */
  regenerateSettling: boolean;
  /**
   * v1.25 — true when the GET reported the last generation attempt failed.
   * Pairs a shown-but-held briefing with a discreet "couldn't refresh" hint,
   * and swaps the generic empty state for a "couldn't generate — retry" one
   * when there is no last good text. Defaults false (no hint) when absent.
   */
  generationFailed: boolean;
  /**
   * v1.25.3 — coarse class of the most recent failure, so the empty state can
   * point its hint at the right lever. Null when the last attempt succeeded or
   * the payload predates the field.
   */
  generationFailureClass: BriefingFailureClass | null;
  /**
   * v1.28.28 (#470) — non-null when the LAST regenerate's grounding gate
   * stripped the briefing. The card renders a distinct, calm "a figure
   * couldn't be verified, so the briefing wasn't shown — try again" state
   * instead of the generic "no briefing yet".
   */
  briefingOmittedReason: "ungrounded" | null;
}

/**
 * Read-only consumer for the advisor payload. Use this on surfaces that
 * just want to render the cached insight (e.g. dashboard preview).
 *
 * The read only fires while the `briefing` capability on `/api/auth/me` is
 * available, whatever the caller passes: every consumer (the overview, the
 * tab strip) gets the same gate, and none can re-enable the read behind the
 * other's back. While `/me` loads the capability reads unavailable, so the
 * first paint never fires a request only to have it refused.
 */
export function useInsightsAdvisorQuery(
  enabled: boolean,
): UseInsightsAdvisorResult {
  const briefing = useAiCapability("briefing");
  const { responseTimeoutMs } = useAiProviderState();
  const queryClient = useQueryClient();
  // Refs #786 — settling state for a timed-out force regenerate (see the
  // contract comment above `AdvisorSettleState`). `settleOutcome` carries the
  // PROVEN outcome once settling resolves; both reset on the next regenerate.
  const [settling, setSettling] = useState<AdvisorSettleState | null>(null);
  const [settleOutcome, setSettleOutcome] = useState<
    "fresh" | "settle-failed" | null
  >(null);
  const query = useQuery({
    queryKey: queryKeys.insightsAdvisor(),
    // v1.15.20 — the cache stores the full tagged result (payload +
    // outcome) so the read path can surface WHY a payload is missing
    // (`no-provider` → connect-AI hint instead of a dead regenerate CTA).
    queryFn: () => fetchAdvisor(),
    enabled: enabled && briefing.available,
    // 24h cache window matches the server-side `insightsCachedAt` TTL.
    staleTime: 60 * 60 * 1000,
    retry: false,
    // v1.16.7 — converge a stale-served briefing in-session: while the
    // last GET reported `revalidating: true` (warm enqueued), poll on a
    // bounded interval until a response comes back with the flag falsy.
    // Refs #786 — settling (timed-out regenerate awaiting its outcome) is
    // the second poll reason, attempts counted from the settle start.
    refetchInterval: (query) =>
      nextAdvisorPollInterval(
        query.state.data?.payload?.revalidating,
        pollAttemptCount(query.state),
        settling,
        advisorRevalidatePollMaxAttempts(responseTimeoutMs),
      ),
  });

  // `dataUpdateCount` lives on the query STATE (the refetchInterval callback
  // reads it there); the observer result only exposes `dataUpdatedAt`. Read
  // it imperatively from the cache where the settle machinery needs it.
  const readDataUpdateCount = useCallback(() => {
    const state = queryClient
      .getQueryCache()
      .find({ queryKey: queryKeys.insightsAdvisor() })?.state;
    return state ? pollAttemptCount(state) : 0;
  }, [queryClient]);

  // Apply the settle resolution the pure seam proves. Each poll result lands
  // in `query.data` (the poll's own cache write IS the fresh payload — no
  // second setQueryData needed) and re-renders this hook; the seam decides
  // fresh / settle-failed / keep-waiting. Render-phase state adjustment (the
  // React-documented alternative to a setState-in-effect): guarded so it
  // fires at most once per settle — resolution non-null clears `settling`,
  // and the next render skips the whole block. Both flips land in the SAME
  // committed render, so the strip's falling-edge toast sees the proven
  // outcome exactly when the busy state drops.
  if (settling) {
    const resolution = resolveAdvisorSettle(
      settling,
      query.data?.payload,
      readDataUpdateCount(),
    );
    if (resolution) {
      setSettling(null);
      setSettleOutcome(resolution);
    }
  }

  const mutation = useMutation({
    mutationFn: () => fetchAdvisor({ force: true, responseTimeoutMs }),
    onSuccess: (result) => {
      if (result.payload) {
        // A genuinely fresh generation landed — write it into the shared
        // cache so the hero subtitle + briefing card repaint immediately.
        queryClient.setQueryData(queryKeys.insightsAdvisor(), result);
      } else {
        // No fresh payload (timeout / no-provider / transient). The server's
        // inline POST may STILL have written a fresh briefing after the
        // client gave up, so re-read the GET to converge — but the
        // honest toast is gated on `regenerateOutcome` below, not on this
        // invalidate.
        //
        // Refs #786 — on a TIMEOUT specifically, one early invalidate is not
        // convergence: the generation routinely outlives it, the re-read
        // serves the OLD cache, and staleTime 1 h + focus-refetch-off remove
        // every later trigger. Enter the settling state instead: remember
        // the baseline this page is showing and poll (bounded) until the
        // cache provably advances or fails — the strip stays busy and no
        // error toast fires until then.
        if (result.outcome === "timeout") {
          const current = queryClient.getQueryData<AdvisorFetchResult>(
            queryKeys.insightsAdvisor(),
          );
          setSettleOutcome(null);
          setSettling({
            baselineCachedAt: current?.payload?.cachedAt ?? null,
            baselineFailed: current?.payload?.generationFailed ?? false,
            startedAtUpdateCount: readDataUpdateCount(),
          });
        }
        queryClient.invalidateQueries({
          queryKey: queryKeys.insightsAdvisor(),
        });
      }
      // Per-status caches are evicted server-side on regenerate; refresh
      // their query subtree so the per-section text below the advisor card
      // re-fetches.
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      // v1.18.10 / v1.32.19 — the dashboard hero surfaces the briefing
      // headline from the SNAPSHOT (server-lifted `User.insightsCachedTextEncrypted`),
      // and the Today hero's lead line is the SAME briefing lifted into the
      // digest — neither is this advisor cache. A regenerate rewrites that
      // server cache, so both the snapshot and the digest must refetch.
      // Regenerate runs on `/insights`, where both are UNMOUNTED, so the
      // earlier active-only snapshot invalidation only marked it stale (never
      // refetched, `refetchOnMount: false`) and never touched the digest at
      // all — returning to `/` then showed the previous briefing under the
      // greeting AND in the Today lead for up to 120 s. `refetchInactiveDailyReads`
      // forces both to refetch right here so the return paints the fresh
      // briefing at once.
      void refetchInactiveDailyReads(queryClient);
    },
  });

  // v1.8.3 — stabilise the `regenerate` callback so the memoised
  // `<InsightsTabStrip>` (which receives it as `onRegenerate`) is not
  // re-rendered on every shell render by a fresh arrow reference. A
  // status-query flip on a sub-page that re-renders the shell would
  // otherwise re-reconcile the whole strip mid-gesture and eat taps.
  const { mutate } = mutation;
  const regenerate = useCallback(() => {
    // Refs #786 — a new attempt clears any previous settle verdict so a
    // stale "fresh"/"settle-failed" cannot leak into this cycle's toast.
    setSettling(null);
    setSettleOutcome(null);
    mutate();
  }, [mutate]);

  return {
    payload: query.data?.payload ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    regenerate,
    isRegenerating: mutation.isPending,
    regenerateError: (mutation.error as Error | null) ?? null,
    // Refs #786 — a proven settle verdict wins over the mutation's raw
    // outcome ("timeout" while settling is an interim state, not a result).
    regenerateOutcome: settleOutcome ?? mutation.data?.outcome ?? null,
    regenerateSettling: settling !== null,
    // Absent (pre-field cached payload or unsettled query) → not failed, so a
    // transient unknown never flashes a false "couldn't refresh" hint.
    generationFailed: query.data?.payload?.generationFailed ?? false,
    // Absent → no specific lever hint; the generic failed-description holds.
    generationFailureClass: query.data?.payload?.generationFailureClass ?? null,
    // v1.28.28 (#470) — a force-regenerate response carries the field via
    // setQueryData; since v1.28.30 the GET carries it too (marker-backed),
    // so the "withheld" state persists across reads and clears on the next
    // successful generation.
    briefingOmittedReason: query.data?.payload?.briefingOmittedReason ?? null,
  };
}
