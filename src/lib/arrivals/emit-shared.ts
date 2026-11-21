/**
 * Generator-free enqueue contract for the `data-arrival` queue.
 *
 * Mirrors the `morning-digest-refresh-shared.ts` split exactly: queue name +
 * payload + `boss.send` live here, with NO import of the worker module, so a
 * sleep sync, a workout batch, or a lab write never drags the reaction tree
 * (and its transitive insight imports) into its own module graph. The worker
 * lives in `@/lib/jobs/data-arrival` and re-exports the queue name from here so
 * there is one source of truth.
 *
 * Cost discipline at the seam, because this code runs in front of every ingest
 * path in the product:
 *
 *   - Called ONCE per write batch, never per row. The caller passes the newest
 *     sample it inserted and how many rows it inserted; the spine never walks a
 *     batch.
 *   - No row reads. The only lookups are `resolveUserTimezone` and
 *     `resolveModuleMap`, both process-cached per user, and both already on the
 *     hot path of the seams this joins.
 *   - Fire-and-forget and fully try/caught. An emit failure can NEVER fail the
 *     ingest that called it — the discipline of `maybeEnqueueMorningRefresh`
 *     (`morning-refresh-trigger.ts`, its outer catch). Callers still
 *     `void emitDataArrival(...).catch(() => {})` for defence in depth.
 *   - Non-salient never reaches the queue. A backfill is annotated and dropped
 *     at the seam, so trigger volume is observable before any surface consumes
 *     the spine.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { resolveModuleMap } from "@/lib/modules/gate";
import { resolveUserTimezone } from "@/lib/tz/resolver";

import { classifyArrival } from "./salience";
import type { ArrivalKind, DataArrival } from "./types";
import { userDayKey } from "@/lib/tz/format";

export const DATA_ARRIVAL_QUEUE = "data-arrival";

/**
 * Device double-post window for the one kind whose key is not day-scoped.
 *
 * `workout` is keyed by the workout id rather than the local date, because two
 * different workouts on one day are two different events and must both react.
 * That key is re-fireable, so it takes a time window the way
 * `insight-status-generate-shared.ts` does. Five minutes covers a watch
 * posting the same session twice during a sync retry.
 *
 * Every OTHER kind is day-scoped and takes NO window — see the table in
 * `arrivalSendOptions` for why a wall-clock throttle is the wrong tool there.
 */
const WORKOUT_SINGLETON_SECONDS = 300;

export interface EmitArrivalInput {
  userId: string;
  kind: ArrivalKind;
  /** The newest sample this write actually inserted. */
  newestSampleAt: Date;
  /**
   * Rows INSERTED by this write. An upsert that merely updated an existing row
   * MUST pass 0 — that is what keeps a re-sync silent.
   */
  insertedCount: number;
  /** Workout id for `workout`; the panel's collection day for `labs_panel`. */
  refId?: string;
  /** Transport token, for annotations only. Never used for a decision. */
  source: string;
  /** Injectable for tests; production always uses the real clock. */
  now?: Date;
}

/**
 * The module each kind depends on. A user who turned the domain off gets no
 * events for it — checked at the seam so a disabled module costs one cached
 * map lookup rather than a queued job.
 *
 * `weight` and `blood_pressure` are CORE domains (always on, see
 * `CORE_DOMAIN_KEYS` in `@/lib/modules/registry`), so they name no gate.
 */
const KIND_MODULE: Partial<Record<ArrivalKind, "sleep" | "workouts" | "labs">> =
  {
    sleep_night: "sleep",
    workout: "workouts",
    labs_panel: "labs",
  };

/**
 * Per-kind de-duplication key + window.
 *
 * The day-scoped kinds take a day-unique key and NO `singletonSeconds`, which
 * is the shape `morning-digest-refresh-shared.ts` documents at length: a
 * `singletonSeconds` window is a `floor()` over WALL-CLOCK time, so it can
 * neither express a user's local date nor line up with one. It would both split
 * a single local day across two buckets and merge two local days into one. The
 * local date already lives in the key; the queue policy just has to honour it.
 *
 * Honouring it is not automatic. Under pg-boss's default `standard` policy NO
 * index covers `singleton_key`, so a bare key coalesces NOTHING. The queue is
 * therefore registered `exclusive` in `reminder/register-status.ts`; if that
 * entry is ever removed these keys go silently inert. The two belong together.
 */
function arrivalSendOptions(
  kind: ArrivalKind,
  userId: string,
  localDate: string,
  refId: string | undefined,
): Record<string, unknown> {
  const base = {
    // The worker is cheap and provider-free, so it takes the morning-refresh
    // retry policy rather than the slower LLM one.
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
  };

  if (kind === "workout") {
    return {
      ...base,
      singletonKey: `arrival:${userId}:workout:${refId ?? localDate}`,
      singletonSeconds: WORKOUT_SINGLETON_SECONDS,
    };
  }

  return {
    ...base,
    singletonKey: `arrival:${userId}:${kind}:${localDate}`,
  };
}

/**
 * Classify a write, and enqueue a `DataArrival` only if it is genuinely news.
 *
 * Returns nothing and throws nothing. Every exit annotates, so the volume of
 * emitted vs. skipped events is visible in wide events before any surface
 * consumes the spine.
 */
export async function emitDataArrival(input: EmitArrivalInput): Promise<void> {
  const { userId, kind, newestSampleAt, insertedCount, refId, source } = input;
  const now = input.now ?? new Date();

  try {
    // Recency first: the zone is cached, the module map is three reads, and
    // a history import lands here once per row it inserts, almost all of
    // them old.
    const tz = await resolveUserTimezone(userId);
    const classification = classifyArrival({
      kind,
      newestSampleAt,
      insertedCount,
      now,
      tz,
    });

    if (classification !== "salient") {
      // The diagnostic gate. A mass import lands here for every one of its
      // batches, so the meta carries enough to tell a backfill apart from a
      // timezone mistake without a code change.
      annotate({
        action: { name: `arrival.${kind}.skipped` },
        meta: {
          reason: classification,
          source,
          tz,
          inserted: insertedCount,
          sample_local_date:
            classification === "backfill"
              ? userDayKey(newestSampleAt, tz)
              : undefined,
        },
      });
      return;
    }

    const moduleKey = KIND_MODULE[kind];
    if (moduleKey) {
      const modules = await resolveModuleMap(userId);
      if (modules[moduleKey] === false) {
        annotate({
          action: { name: `arrival.${kind}.skipped` },
          meta: { reason: "module_off", source },
        });
        return;
      }
    }

    const localDate = userDayKey(now, tz);
    const payload: DataArrival = {
      userId,
      kind,
      salience: "salient",
      localDate,
      occurredAt: newestSampleAt.toISOString(),
      refId,
      count: insertedCount,
      source,
    };

    const boss = getGlobalBoss();
    if (!boss) {
      // A web process without an embedded worker. Not an error: the surfaces
      // this spine feeds all degrade to their deterministic form, and the next
      // landing on a worker-bearing process re-emits.
      annotate({
        action: { name: `arrival.${kind}.skipped` },
        meta: { reason: "no_boss", source, local_date: localDate },
      });
      return;
    }

    await boss.send(
      DATA_ARRIVAL_QUEUE,
      payload,
      arrivalSendOptions(kind, userId, localDate, refId),
    );

    annotate({
      action: { name: `arrival.${kind}.emitted` },
      meta: {
        salience: "salient",
        count: insertedCount,
        source,
        local_date: localDate,
      },
    });
  } catch {
    // Never let a reaction trigger fail an ingest. The data is already written;
    // the reaction is garnish, and the next landing is the catch-net.
  }
}
