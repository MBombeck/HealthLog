/**
 * The paginated `dataPoints.list` walker: page by page under the budget in
 * scope (`./budget.ts`), resumable from a saved place, falling back when
 * Google refuses an edge filter, and the collecting `fetchDataPoints` built
 * on it.
 */
import { annotate, getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { GoogleHealthApiError } from "./response-classifier";
import {
  googleHealthSampleInstant,
  type GoogleHealthDataPoint,
  type GoogleHealthDataType,
} from "./mappers";
import {
  googleHealthWalkProgress,
  noteGoogleHealthWalkPage,
} from "./backfill-bounds";
import {
  notePagination,
  stopRequested,
  noteSlicePage,
  noteSliceSkip,
  extendSliceDeadline,
  sliceNow,
  endSlice,
  inSlice,
} from "./budget";
import {
  GoogleHealthDateFilterStyle,
  incrementalFilter,
  GoogleHealthAccessToken,
  googleHealthDataRequest,
} from "./request";
import { GOOGLE_HEALTH_API_BASE } from "./request";
import { GOOGLE_HEALTH_NO_PROGRESS_PAGES } from "./backfill-bounds";

// ─── Data-point reads (Google Health `dataPoints.list` / `:dailyRollUp`) ──────
//
// The Google Health API exposes one uniform `DataPoint` resource shape across
// every data type. Spot / daily-summary / session types are read through
// `GET /v4/users/me/dataTypes/{dataType}/dataPoints` with `nextPageToken`
// pagination; the cumulative activity types (steps / distance / active energy /
// floors) are read through `POST …/dataPoints:dailyRollUp` — their `list`
// surface returns minute-grain observation buckets (or, for floors, does not
// exist at all), so the daily totals MUST come from the rollup.
//
// Casing gotcha (three encodings per type, all pinned in
// `GOOGLE_HEALTH_DATA_TYPES` so a fetcher can never mix them up):
//   - request path:      kebab-case  (`body-fat`)
//   - `filter` predicate: snake_case (`body_fat.sample_time.physical_time`) —
//     EXCEPT daily-summary `.date` filters, where the docs contradict
//     themselves and the worked example uses the camelCase payload key; the
//     client sends camel first and falls back to snake on a first-page 400
//     (see `GoogleHealthDateFilterStyle`).
//   - response payload:   camelCase — the `DataPoint` value is a union keyed by
//     the camelCase type name (`bodyFat`, `dailyRestingHeartRate`, …) with
//     camelCase nested objects (`sampleTime.physicalTime`,
//     `interval.startTime`, `civilStartTime.date`).
//

// proto3 int64 fields arrive as JSON **strings** (`"12345"`) — every numeric
// extractor coerces numeric strings before the finite check.

/**
 * Page-size ceiling for `dataPoints.list`. The daily/intraday reads default to
 * 1440 (one-per-minute) and cap at 10 000; sleep/exercise cap at 25. The launch
 * metrics use the daily/spot reads, so the default page size is the larger.
 */
export const GOOGLE_HEALTH_PAGE_SIZE = 1000;

/** Sleep/exercise read cap — matches the Google Health 25-cap for those types. */
export const GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE = 25;

/**
 * Page ceiling for one intraday heart-rate walk.
 *
 * Per walk, never across walks: a backfill reads at most a slice's pages per
 * walk and keeps its place between slices, and an hourly sync reads a few
 * pages. What stops a walk that keeps going without getting anywhere is the
 * progress guard (`GOOGLE_HEALTH_NO_PROGRESS_PAGES`), and what bounds a
 * backfill that does get somewhere is its horizon in years (see
 * `backfill-bounds.ts`). The walk is paged (`forEachDataPointPage`), so the
 * ceiling costs time, not memory.
 */
export const GOOGLE_HEALTH_DENSE_MAX_PAGES = 10_000;

/** Page ceiling for every other list walk. */
export const GOOGLE_HEALTH_DEFAULT_MAX_PAGES = 1000;

/** `dataPoints.list` envelope: `{ dataPoints, nextPageToken }`. */
interface GoogleHealthDataPointPage {
  dataPoints?: GoogleHealthDataPoint[];
  nextPageToken?: string | null;
}

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `GOOGLE_HEALTH_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
  /**
   * The user's IANA zone — needed only by the `civilStart` filter (the
   * offset-less civil bound must be the watermark's wall clock in the USER'S
   * zone). Omitted → the bound forms in UTC.
   */
  tz?: string;
  /**
   * Observes which daily-summary `.date` filter prefix style the walk settled
   * on (`camel` worked-example vs `snake` fallback) — the structure probe
   * surfaces it so a live account reports which grammar Google accepted.
   */
  onDateFilterStyle?: (style: GoogleHealthDateFilterStyle) => void;
  /**
   * The walk keeps its place across attempts (a backfill's resume cursor), so
   * it may stop on the backfill slice's budget and on a rate limit it cannot
   * wait out, and report itself truncated instead of failing: the next slice
   * picks up from the edge it recorded.
   */
  resumable?: boolean;
  /**
   * Where an earlier attempt of this walk got to: the oldest sample it wrote
   * when the walk ran newest first (`desc`), the newest when it ran oldest
   * first (`asc`). The walk asks only for the samples at or beyond it; the
   * one sample on the edge itself is read again and overwrites in place.
   *
   * `filter: false` reads without the edge bound and passes over the samples
   * beyond the edge here instead (see `forEachDataPointPage`); the walk falls
   * back to that on its own when Google refuses the bound, and calls
   * `onFilterUnsupported` once when it does. `tz` reads an offset-less sample
   * time the way the edge was recorded. Passing over has no page bound of
   * its own: the pages passed over move toward the edge, and a walk whose
   * pages stop moving is stopped by the progress guard like any other.
   *
   * A walk without the bound keeps its place in that list across slices:
   * `resumeFrom` is where an earlier slice's walk stopped, and
   * `onResumePoint` is told where this one stops (see
   * `GoogleHealthResumePoint`).
   */
  edge?: {
    at: Date;
    order: "desc" | "asc";
    filter?: boolean;
    tz?: string;
    onFilterUnsupported?: () => void | Promise<void>;
    resumeFrom?: GoogleHealthResumePoint;
    onResumePoint?: (point: GoogleHealthResumePoint) => void | Promise<void>;
  };
  /**
   * Told once when the walk is stopped for going
   * `GOOGLE_HEALTH_NO_PROGRESS_PAGES` pages in a row without reaching any
   * further back (see `backfill-bounds.ts`). The walk then reports itself
   * truncated, as it does on its page ceiling.
   */
  onNoProgress?: () => void | Promise<void>;
}

/**
 * Where a walk without the edge bound stopped in the unbounded list: the page
 * token that fetched the last page it read, and that page's position (pages
 * from the newest one, which is position 0). The next slice starts by reading
 * that page again rather than the newest one, so it passes over only what is
 * left between it and the edge instead of everything earlier slices wrote.
 *
 * Re-reading the last page, not the one after it, is what lets the walk check
 * the token still points where it did: the page must hold a sample at or
 * beyond the edge. A list that lost samples in between could otherwise move
 * the token past samples nobody wrote. A page that fails the check, or a
 * token Google refuses, sends the walk back to the newest page, the way it
 * read before it kept its place.
 */
export interface GoogleHealthResumePoint {
  token: string;
  page: number;
}

/**
 * The longest a walk passes over samples beyond its edge in one slice before
 * it stops and keeps its place for the next. Shorter than the slice, so a
 * slice that has to skip still writes, and never longer than it: a skip runs
 * on the slice's clock and the account's lock is held no longer than a slice.
 */
export const GOOGLE_HEALTH_SKIP_MS = 3 * 60 * 1000;

/**
 * Walk every `DataPoint` for one data type since the incremental cursor via
 * `dataPoints.list` with `nextPageToken` pagination. The data-type id is
 * kebab-cased in the path; the `filter` predicate is built per-shape against
 * the type's time anchor. `rollup` types refuse — they read via
 * `fetchDailyRollUp`.
 *
 * DAILY-SUMMARY FILTER FALLBACK: the docs contradict themselves on the `.date`
 * filter's type-name prefix (the index's "filter parameter" column says
 * snake_case; the list reference's only worked example says camelCase — see
 * `GoogleHealthDateFilterStyle`). The walk sends the camelCase worked-example
 * form first; if the VERY FIRST request of the walk is rejected with a 400,
 * the whole walk retries once with the snake_case form. The style that
 * succeeded is annotated as `googleHealth.dateFilter.style` so live behaviour
 * reports which grammar Google actually accepts. Any other failure, or a 400
 * past the first request, propagates.
 */
export async function fetchDataPoints(
  dataType: GoogleHealthDataType,
  accessToken: GoogleHealthAccessToken,
  verb: string,
  query: DataPointQuery = {},
): Promise<GoogleHealthDataPoint[]> {
  const points: GoogleHealthDataPoint[] = [];
  await forEachDataPointPage(dataType, accessToken, verb, query, (page) => {
    for (const p of page) points.push(p);
  });
  return points;
}

/**
 * The same walk as `fetchDataPoints`, handing each page to `onPage` as it
 * arrives instead of collecting the whole collection first.
 *
 * A dense collection has to be read this way. Intraday heart rate is one
 * point a minute, so a full-history backfill of two years is over a million
 * points; held as parsed JSON and then again as mapped readings, that is more
 * than a 1 GB heap, and the process that runs the backfill also serves the
 * app. Page by page, only one page is ever resident.
 *
 * `onPage` is awaited before the next page is requested, so a slow write
 * applies back-pressure to the fetch. The date-filter fallback still works:
 * it only fires when the first request is rejected, which is before any page
 * reaches `onPage`.
 *
 * `onPage` answers `"end"` when the caller has read as far as it wants (a
 * backfill that reached its horizon): the walk ends there as complete, not
 * truncated.
 *
 * A walk over spot readings (`timeField: "sample"`) also watches whether it
 * is getting anywhere: `GOOGLE_HEALTH_NO_PROGRESS_PAGES` pages in a row that
 * reach no further back than the pages before them end it, truncated, and
 * tell `onNoProgress` (see `backfill-bounds.ts`).
 */
export async function forEachDataPointPage(
  dataType: GoogleHealthDataType,
  accessToken: GoogleHealthAccessToken,
  verb: string,
  query: DataPointQuery,
  onPage: (
    points: GoogleHealthDataPoint[],
  ) => void | "end" | Promise<void | "end">,
): Promise<void> {
  const maxPages = query.maxPages ?? GOOGLE_HEALTH_DEFAULT_MAX_PAGES;
  const pageSize = query.pageSize ?? GOOGLE_HEALTH_PAGE_SIZE;
  const resumable = query.resumable === true;
  const edge = query.edge;

  let requestCount = 0;

  const walk = async (
    dateStyle: GoogleHealthDateFilterStyle,
    edgeBy: "filter" | "skip",
    resumeFrom: GoogleHealthResumePoint | undefined,
    restarted: boolean,
  ): Promise<void> => {
    let fetched = 0;
    let pageToken: string | null | undefined = resumeFrom?.token;
    // The token that fetched the page last read, and that page's position.
    let lastToken: string | undefined;
    let lastPosition = -1;
    let pageCount = 0;
    let stopped = false;
    // Reading without the edge bound: the pages before the edge are passed
    // over, not written, until the first sample at or beyond it.
    const skipTo = edge && edgeBy === "skip" ? edge : undefined;
    let crossed = skipTo === undefined;
    // Pages passed over in this walk. Never reset: the walk's page ceiling
    // counts the pages it wrote, `pageCount - skipped`, before the crossing
    // and after it alike.
    let skipped = 0;
    const startPosition = resumeFrom?.page ?? 0;
    const skipStartedAt = skipTo ? sliceNow() : 0;
    // Whether the walk is still reaching further back. A walk filtered to
    // the edge starts from it; one passing over the samples beyond the edge
    // starts from nothing, since those pages move toward the edge too.
    const progress =
      dataType.timeField === "sample"
        ? googleHealthWalkProgress(edge && edgeBy === "filter" ? edge : null)
        : null;
    const progressTz = edge?.tz ?? query.tz;
    let noProgress = false;
    const sampleAt = (point: GoogleHealthDataPoint): number | null =>
      googleHealthSampleInstant(point, dataType, skipTo?.tz)?.getTime() ?? null;
    const beyondEdge = (point: GoogleHealthDataPoint): boolean | null => {
      const t = sampleAt(point);
      if (t === null || !skipTo) return null;
      return skipTo.order === "desc"
        ? t > skipTo.at.getTime()
        : t < skipTo.at.getTime();
    };
    const reachesEdge = (point: GoogleHealthDataPoint): boolean => {
      const t = sampleAt(point);
      if (t === null || !skipTo) return false;
      return skipTo.order === "desc"
        ? t >= skipTo.at.getTime()
        : t <= skipTo.at.getTime();
    };

    do {
      // A skip that had to start over from the newest page runs as the walk
      // did before it kept its place: on the job's budget alone, its time
      // given back to the slice once it crosses. Every other read stops on
      // the slice's budget, and a skip also on its own shorter limit; it
      // keeps its place below, so the next slice goes on from there.
      const untimed = !crossed && restarted;
      if (untimed ? stopRequested(false) : stopRequested(resumable)) {
        stopped = true;
        break;
      }
      if (
        !crossed &&
        !untimed &&
        resumable &&
        inSlice() &&
        sliceNow() - skipStartedAt >= GOOGLE_HEALTH_SKIP_MS
      ) {
        stopped = true;
        break;
      }
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      const filters: string[] = [];
      if (query.start) {
        const { field, bound } = incrementalFilter(
          dataType,
          query.start,
          query.tz,
          dateStyle,
        );
        filters.push(`${field} >= "${bound}"`);
      }
      const edgeFiltered = edge !== undefined && edgeBy === "filter";
      if (edgeFiltered) {
        const { field, bound } = incrementalFilter(
          dataType,
          edge.at,
          query.tz,
          dateStyle,
        );
        filters.push(
          `${field} ${edge.order === "desc" ? "<=" : ">="} "${bound}"`,
        );
      }
      if (filters.length > 0) params.set("filter", filters.join(" AND "));
      if (pageToken) params.set("pageToken", pageToken);

      requestCount += 1;
      // The first filtered daily-summary read answering 400
      // is the expected trigger for the snake_case retry below, not a
      // failure: some accounts reject the documented camelCase prefix on
      // some types, and the very next request answers 200. It was logged as
      // an error next to the 200 that followed it. It is recorded as a note
      // now; any other 400 still carries its error. The same holds for the
      // first resumed request refusing the edge bound, and for a saved
      // place in the unbounded list Google no longer takes.
      const firstRequest = requestCount === 1;
      const firstOfWalk = pageCount === 0;
      const edgeRefused = (status: number, detail: string | undefined) =>
        edgeFiltered &&
        firstOfWalk &&
        status === 400 &&
        refusesEdgeFilter(detail);
      const resumeRefused = (status: number) =>
        resumeFrom !== undefined && firstOfWalk && status === 400;
      const requestToken = pageToken ?? undefined;
      const { status, json, verdict, apiErrorDetail } =
        await googleHealthDataRequest<GoogleHealthDataPointPage>(
          accessToken,
          `${verb}(page=${pageCount})`,
          (token) =>
            safeFetch(
              `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints?${params}`,
              {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
              },
            ),
          (status, detail) =>
            canFallBack &&
            dateStyle === "camel" &&
            firstRequest &&
            status === 400
              ? "date_filter_rejected_retrying_snake_case"
              : edgeRefused(status, detail)
                ? "edge_filter_rejected_reading_without_it"
                : resumeRefused(status)
                  ? "resume_token_rejected_reading_from_newest"
                  : undefined,
        );
      if (edgeRefused(status, apiErrorDetail)) {
        throw new EdgeFilterRefused();
      }
      if (resumeRefused(status)) throw new ResumePointLost();
      // A rate limit the request could not wait out ends a resumable walk
      // inside a backfill slice where it is: the pages before it are written
      // and their edge recorded, so this is a pause, not a failure. The slice
      // ends with it, since every other walk would meet the same quota.
      if (status === 429 && resumable && inSlice()) {
        endSlice("rate_limited");
        stopped = true;
        break;
      }
      if (verdict.classification !== "success") {
        throw new GoogleHealthApiError({
          verb,
          classification: verdict.classification,
          httpStatus: verdict.httpStatus,
          reason: verdict.reason,
          upstreamError: apiErrorDetail,
        });
      }

      let page = json?.dataPoints ?? [];
      // A saved place has to still hold a sample at or beyond the edge;
      // past it, samples nobody wrote could lie behind the token.
      if (resumeFrom && firstOfWalk && !page.some(reachesEdge)) {
        throw new ResumePointLost();
      }
      if (requestToken !== undefined) {
        lastToken = requestToken;
        lastPosition = startPosition + pageCount;
      }
      pageToken = json?.nextPageToken ?? null;
      pageCount += 1;
      fetched += page.length;
      noteSlicePage();
      if (
        progress &&
        noteGoogleHealthWalkPage(
          progress,
          page.map(
            (p) =>
              googleHealthSampleInstant(p, dataType, progressTz)?.getTime() ??
              null,
          ),
        )
      ) {
        getEvent()?.addWarning(
          `google-health ${verb}: ${GOOGLE_HEALTH_NO_PROGRESS_PAGES} pages in a row reached no further back than ${progress.furthest === null ? "the first" : new Date(progress.furthest).toISOString()}; walk stopped`,
        );
        noProgress = true;
        stopped = true;
        break;
      }
      if (!crossed) {
        // Placed samples beyond the edge were written by an earlier slice;
        // one without a sample time cannot be placed and is passed over
        // with them until the walk is past the edge.
        const kept = page.filter((p) => beyondEdge(p) === false);
        if (kept.length === 0) {
          skipped += 1;
          noteSliceSkip();
          continue;
        }
        crossed = true;
        if (restarted) extendSliceDeadline(sliceNow() - skipStartedAt);
        page = page.filter((p) => beyondEdge(p) !== true);
      }
      if ((await onPage(page)) === "end") {
        pageToken = null;
        break;
      }
    } while (pageToken && pageCount - skipped < maxPages);

    const truncated = stopped || Boolean(pageToken);
    // Keep the place for the next slice. Only a walk without the bound has
    // one, and only one that ended short needs it.
    if (skipTo && truncated && lastToken !== undefined) {
      await skipTo.onResumePoint?.({ token: lastToken, page: lastPosition });
    }
    notePagination(pageCount, fetched, truncated);
    if (noProgress) await query.onNoProgress?.();
  };

  // The fallback only exists for filtered daily-summary reads — every other
  // shape has one documented, doc-consistent filter field.
  const canFallBack =
    dataType.timeField === "date" && query.start !== undefined;

  let style: GoogleHealthDateFilterStyle = "camel";
  let edgeBy: "filter" | "skip" = edge?.filter === false ? "skip" : "filter";
  // From the saved place in the unbounded list when there is one; once from
  // the newest page when that place is lost.
  const walkSkipping = async (dateStyle: GoogleHealthDateFilterStyle) => {
    const resumeFrom = edge?.resumeFrom;
    if (!resumeFrom) return walk(dateStyle, "skip", undefined, false);
    try {
      await walk(dateStyle, "skip", resumeFrom, false);
    } catch (err) {
      if (!(err instanceof ResumePointLost)) throw err;
      await walk(dateStyle, "skip", undefined, true);
    }
  };
  const run = async (dateStyle: GoogleHealthDateFilterStyle) => {
    if (edgeBy === "skip") return walkSkipping(dateStyle);
    try {
      await walk(dateStyle, edgeBy, undefined, false);
    } catch (err) {
      if (!(err instanceof EdgeFilterRefused)) throw err;
      // Once: the walk without the bound sends no edge filter to refuse.
      edgeBy = "skip";
      await edge?.onFilterUnsupported?.();
      await walk(dateStyle, edgeBy, undefined, false);
    }
  };
  try {
    await run("camel");
  } catch (err) {
    const firstRequestRejected =
      canFallBack &&
      requestCount === 1 &&
      err instanceof GoogleHealthApiError &&
      err.httpStatus === 400;
    if (!firstRequestRejected) throw err;
    style = "snake";
    await run("snake");
  }
  if (canFallBack) {
    annotate({ meta: { "googleHealth.dateFilter.style": style } });
    query.onDateFilterStyle?.(style);
  }
}

/**
 * Thrown inside a walk whose first request Google refused because of the
 * resume edge's bound; `forEachDataPointPage` reads the collection again
 * without it.
 */
class EdgeFilterRefused extends Error {
  constructor() {
    super("google-health: edge filter refused");
  }
}

/**
 * Thrown inside a walk that started from a saved place in the unbounded list
 * (`GoogleHealthResumePoint`) when Google refused the token or the page it
 * returned no longer reaches the edge; the walk starts over from the newest
 * page.
 */
class ResumePointLost extends Error {
  constructor() {
    super("google-health: saved place in the list lost");
  }
}

/**
 * Whether a 400 on the first resumed request is Google refusing the edge
 * bound, rather than something else about the request. The request differs
 * from one Google answers every hour only by that bound, so a bare 400 or an
 * INVALID_ARGUMENT counts, and so does any message naming the filter; one
 * naming the page token, the page size or the access token does not.
 */
export function refusesEdgeFilter(detail: string | undefined): boolean {
  if (detail === undefined) return true;
  if (/filter/i.test(detail)) return true;
  if (/token|page.?size/i.test(detail)) return false;
  return /INVALID_ARGUMENT/.test(detail);
}
