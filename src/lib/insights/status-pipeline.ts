/**
 * The pipeline every per-card status generator runs, in stages.
 *
 * A card is a plug-in: what it reads and how it shapes that into a snapshot,
 * the prompts it sends, and, for the one card that stores more than a note,
 * how its note is stored and what its result looks like. Everything around
 * that is the same for every card and lives here:
 *
 *   openStatusCard            locale, note name, the reader's day
 *   readCachedStatus          today's note, when there is one
 *   resolveReadOnlyStatus     a navigation read never waits on a provider
 *   gateUnchangedInputs       slow-moving inputs unchanged: re-date the note
 *   sealStatusSnapshot        budget, serialise, fingerprint
 *   refreshUnchangedStatus    snapshot unchanged: re-date the note
 *   buildStatusPromptContext  previous note, variety lead, data strength,
 *                             relations, opener hint
 *   pendingStatusCard         the descriptor the single-card path
 *                             (`runPreparedStatusCard`) and the batch drive
 *
 * `prepareStatusCard` runs them in order for a plug-in. The generic metric
 * card and the biomarker card compose the same stages themselves, because
 * each puts an empty-data gate between the cache read and the read-only path.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import { statusSnapshotCharsForRecord } from "@/lib/ai/capabilities/usage";
import type { Locale } from "@/lib/i18n/config";
import {
  buildAssessmentContextBlock,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { degradeStatusSnapshotToBudget } from "@/lib/insights/graded-series";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { getRelevantCorrelationsForMetric } from "@/lib/insights/metric-correlation-context";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import {
  gateUnchangedStatusInput,
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
  type ReadOnlyMissOutcome,
} from "@/lib/insights/status-cache";
import type {
  PendingStatusCard,
  PreparedStatusCard,
  StatusCardResult,
} from "@/lib/insights/status-card-generation";
import {
  finalizeStatusSummary,
  normalizeLocale,
  persistStatusInsight,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import {
  returnTimeoutFallback,
  type StatusFallbackReason,
} from "@/lib/insights/timeout-fallback";
import type {
  InsightStatusMetric,
  InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";

/** What every public generator entry accepts. */
export interface StatusCardOptions {
  locale?: string | null;
  force?: boolean;
  /**
   * Read-only mode for the navigation path. On a cache miss the generator
   * does NOT run the SQL gather + blocking LLM inline; it enqueues an
   * out-of-band generation and returns a `preparing` shape so the request
   * never awaits the provider. The worker (and the nightly pre-generate cron)
   * call with `readOnly: false` to actually generate.
   */
  readOnly?: boolean;
}

/** The note-only result every card but medication compliance returns. */
export type StatusTextResult = {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /** Last-good text served while a refresh is in flight; keep polling. */
  revalidating?: boolean;
};

/** One card's run: who, which note, and the reader's day. */
export interface StatusCardContext<
  S extends InsightStatusScope = InsightStatusScope,
> {
  userId: string;
  scope: S;
  locale: SupportedLocale;
  force: boolean;
  readOnly: boolean;
  /** `insights.<scope>.<locale>` — the note name and the consent-gate key. */
  cacheAction: string;
  userTz: string;
  todayKey: string;
}

/** The fingerprints a written note carries for the next run's gates. */
export interface StatusNoteHashes {
  snapshotHash?: string;
  inputHash?: string;
}

/**
 * How a card stores its note and shapes its result. Every card stores one
 * note and answers `{ hasProvider, text, cached, updatedAt }`
 * (`textStatusCodec`); medication compliance stores per-medication lines
 * beside it and answers with them, so it brings its own codec. `I` is the
 * card's per-run detail the codec needs on the way out (those lines).
 */
export interface StatusNoteCodec<R extends StatusCardResult, I> {
  readFresh(ctx: StatusCardContext): Promise<R | null>;
  refreshUnchanged(
    ctx: StatusCardContext,
    snapshotHash: string,
  ): Promise<R | null>;
  readOnly(outcome: ReadOnlyMissOutcome, unavailableText: string): R;
  noProvider(text: string): R;
  fallback(
    ctx: StatusCardContext,
    reason: StatusFallbackReason,
    stubText: string,
    detail: I,
  ): R;
  persist(
    ctx: StatusCardContext,
    text: string,
    hashes: StatusNoteHashes,
    detail: I,
  ): Promise<R>;
}

/** The standard codec: one encrypted note, a text-shaped result. */
export const textStatusCodec: StatusNoteCodec<StatusTextResult, undefined> = {
  async readFresh(ctx) {
    // Serve today's real assessment when present. The shared reader rejects
    // timeout stubs, so a single stall no longer pins the fallback for the
    // day.
    const cached = await readFreshStatusText({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
      force: ctx.force,
    });
    if (!cached) return null;
    return {
      hasProvider: true,
      text: cached.text,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  },
  async refreshUnchanged(ctx, snapshotHash) {
    const unchanged = await refreshUnchangedStatusInsight({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
      snapshotHash,
    });
    if (!unchanged) return null;
    return {
      hasProvider: true,
      text: unchanged.text,
      cached: true,
      updatedAt: unchanged.updatedAt,
    };
  },
  readOnly(outcome, unavailableText) {
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        hasProvider: outcome.hasProvider,
        text: unavailableText,
        cached: true,
        updatedAt: null,
      };
    }
    // Stale-while-revalidate: serve the last good assessment (if any)
    // instantly while the worker re-warms the cache; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      hasProvider: true,
      text: outcome.lastGood?.text ?? null,
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  },
  noProvider(text) {
    return { hasProvider: false, text, cached: true, updatedAt: null };
  },
  fallback(ctx, reason, stubText) {
    return returnTimeoutFallback({
      cacheAction: ctx.cacheAction,
      reason,
      userId: ctx.userId,
      todayKey: ctx.todayKey,
      stubText,
    });
  },
  async persist(ctx, text, hashes) {
    const updatedAt = await persistStatusInsight({
      userId: ctx.userId,
      cacheAction: ctx.cacheAction,
      todayKey: ctx.todayKey,
      text,
      snapshotHash: hashes.snapshotHash,
      inputHash: hashes.inputHash,
    });
    return { hasProvider: true, text, cached: false, updatedAt };
  },
};

/**
 * Resolve the run: locale, the note name, and the reader's day. The user's
 * own time zone is resolved BEFORE the day key so the cache rolls over at the
 * user's local midnight, not Berlin's; it has to happen ahead of the cache
 * read (the earliest possible return path), not just the later day-bucketing
 * reads.
 */
export async function openStatusCard<S extends InsightStatusScope>(
  userId: string,
  scope: S,
  options: StatusCardOptions | undefined,
): Promise<StatusCardContext<S>> {
  const locale = normalizeLocale(options?.locale);
  const cacheAction = statusCacheAction(scope, locale);
  const userTz = await resolveUserTimezone(userId);
  return {
    userId,
    scope,
    locale,
    force: options?.force === true,
    readOnly: options?.readOnly === true,
    cacheAction,
    userTz,
    todayKey: userDayKey(new Date(), userTz),
  };
}

/** Today's stored note as the card's result, or `null` on a miss. */
export function readCachedStatus<R extends StatusCardResult, I>(
  ctx: StatusCardContext,
  codec: StatusNoteCodec<R, I>,
): Promise<R | null> {
  return codec.readFresh(ctx);
}

/**
 * The read-only navigation path: never block on the provider. Enqueue the
 * generation out of band and serve the last good note, the preparing
 * skeleton, or (no provider, no consent) the deterministic line.
 */
export async function resolveReadOnlyStatus<R extends StatusCardResult, I>(
  ctx: StatusCardContext,
  codec: StatusNoteCodec<R, I>,
  unavailableText: string,
): Promise<R> {
  const outcome = await resolveReadOnlyStatusMiss({
    userId: ctx.userId,
    metric: ctx.scope,
    locale: ctx.locale,
  });
  return codec.readOnly(outcome, unavailableText);
}

/**
 * The input gate for a slow-moving card: when the cheap fingerprint of its
 * salient inputs matches the stored note's, re-date that note under today's
 * key and skip the build and the provider. `null` when the build must run.
 */
export async function gateUnchangedInputs(
  ctx: StatusCardContext,
  inputHash: string,
  force: boolean,
): Promise<StatusTextResult | null> {
  const unchanged = await gateUnchangedStatusInput({
    userId: ctx.userId,
    cacheAction: ctx.cacheAction,
    todayKey: ctx.todayKey,
    inputHash,
    force,
  });
  if (!unchanged) return null;
  return {
    hasProvider: true,
    text: unchanged.text,
    cached: true,
    updatedAt: unchanged.updatedAt,
  };
}

/**
 * Fit the snapshot to the record's prompt budget (shedding the coarsest
 * series first), serialise it, record its size, and fingerprint it.
 */
export async function sealStatusSnapshot(
  ctx: StatusCardContext,
  snapshot: object,
): Promise<{ snapshotJson: string; snapshotHash: string }> {
  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
    { maxChars: await statusSnapshotCharsForRecord(ctx.userId) },
  );
  const snapshotJson = JSON.stringify(snapshot);

  annotate({
    action: { name: ctx.cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  return { snapshotJson, snapshotHash: hashInsightSnapshot(snapshot) };
}

/**
 * Content-hash gate: when the snapshot is unchanged since the last real
 * assessment, re-date the stored note and skip the LLM.
 */
export function refreshUnchangedStatus<R extends StatusCardResult, I>(
  ctx: StatusCardContext,
  codec: StatusNoteCodec<R, I>,
  snapshotHash: string,
): Promise<R | null> {
  return codec.refreshUnchanged(ctx, snapshotHash);
}

/** What the anti-repetition block is built from, per card. */
export interface StatusContextInputs {
  /** The key the variety lead rotates on; the card's scope unless it differs. */
  varietyKey?: string;
  /** Consecutive steady weeks/months, or 0 where a card has no single mean. */
  repeatCount: number;
  points: number;
  newestDaysAgo: number | null;
  /**
   * The discovery channel whose FDR-surviving relations the block lists, or
   * `null` for a card with no measurement channel of its own (no fetch).
   */
  relationsFor: MeasurementType | null;
}

/** The prompt blocks every assessment card carries beside its snapshot. */
export interface StatusPromptContext {
  previousContextBlock: string;
  assessmentContextBlock: string;
  openerHint: string;
}

/**
 * The previous-assessment comparison, the diversity / anti-repetition block
 * and the rotating opener hint. All formatting of already-computed data; the
 * correlation fetch is best-effort and resolves to no block on failure, never
 * a generation failure. The opener hint is keyed per (user, card, day) and
 * activates the base prompt's verdict-first opener branch.
 */
export async function buildStatusPromptContext(
  ctx: StatusCardContext<InsightStatusMetric | `metric:${string}`>,
  inputs: StatusContextInputs,
): Promise<StatusPromptContext> {
  const previousContext = await getPreviousInsightContext(
    ctx.userId,
    `${ctx.scope}-status`,
    ctx.locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    ctx.locale,
  );

  const varietyLead = pickVarietyLead(
    ctx.userId,
    inputs.varietyKey ?? ctx.scope,
    ctx.todayKey,
  );
  const relations =
    inputs.relationsFor === null
      ? []
      : await getRelevantCorrelationsForMetric(
          ctx.userId,
          inputs.relationsFor,
          ctx.locale,
        );
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: inputs.points,
        newestDaysAgo: inputs.newestDaysAgo,
      },
      repeatCount: inputs.repeatCount,
      relations,
    },
    ctx.locale,
  );

  return {
    previousContextBlock,
    assessmentContextBlock,
    openerHint: openerArchetypeHint(
      `${ctx.userId}:${ctx.scope}:${ctx.todayKey}`,
      ctx.locale as Locale,
    ),
  };
}

/** Everything a pending card needs beyond the run itself. */
export interface PendingStatusSpec<I> {
  systemPrompt: string;
  userPrompt: string;
  hashes: StatusNoteHashes;
  temperature: number;
  /** The answer budget; the status default when omitted. */
  maxTokens?: number;
  /**
   * The deterministic line served with no provider, after a timeout or error,
   * and when the reply is withheld.
   */
  fallbackText: string;
  /** Thrown if a reply survives the screen with no text at all. */
  emptyMessage: string;
  detail: I;
}

/**
 * The descriptor the single-card path and the batch both drive. A timeout or
 * error is a transient miss (fallback served, short negative window, no
 * assessment persisted); `none` (no provider / no consent) serves the no-key
 * line.
 *
 * The reply passes the outbound safety screen before anything is stored.
 * The only transform here used to be whitespace normalisation, so a
 * dose-change imperative or a fabricated clinical risk score persisted as the
 * day's cached assessment. Policy for a background-generated card is
 * WITHHOLD: serve the deterministic stub and persist no model text (see
 * `finalizeStatusSummary`).
 */
export function pendingStatusCard<R extends StatusCardResult, I>(
  ctx: StatusCardContext,
  codec: StatusNoteCodec<R, I>,
  spec: PendingStatusSpec<I>,
): PendingStatusCard {
  return {
    phase: "pending",
    metric: ctx.scope,
    userId: ctx.userId,
    cacheAction: ctx.cacheAction,
    systemPrompt: spec.systemPrompt,
    userPrompt: spec.userPrompt,
    ...(spec.hashes.snapshotHash !== undefined
      ? { snapshotHash: spec.hashes.snapshotHash }
      : {}),
    temperature: spec.temperature,
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    noProvider: codec.noProvider(spec.fallbackText),
    timeout: (reason) =>
      codec.fallback(ctx, reason, spec.fallbackText, spec.detail),
    finalize: async (outcome) => {
      const screened = finalizeStatusSummary(outcome.content, ctx.locale);
      if (!screened.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction: ctx.cacheAction, reason: screened.reason },
        });
        return codec.fallback(ctx, "screened", spec.fallbackText, spec.detail);
      }
      if (!screened.text) throw new Error(spec.emptyMessage);
      return codec.persist(ctx, screened.text, spec.hashes, spec.detail);
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far a card's data reaches: whole days between its oldest and newest
 * reading, and how many days ago the newest one was (`null` with no data).
 */
export function coverageSpan(
  oldest: Date | null,
  newest: Date | null,
): { totalSpanDays: number; newestDaysAgo: number | null } {
  return {
    totalSpanDays:
      oldest && newest
        ? Math.round((newest.getTime() - oldest.getTime()) / DAY_MS)
        : 0,
    newestDaysAgo: newest
      ? Math.round((Date.now() - newest.getTime()) / DAY_MS)
      : null,
  };
}

/** The temperature every specialised card runs at, matching the archetype cards. */
const STATUS_CARD_TEMPERATURE = 0.45;

/** What a card's snapshot stage hands the pipeline. */
export interface StatusCardBuild<I> {
  snapshot: object;
  /** The input fingerprint to store, for a card with an input gate. */
  inputHash?: string;
  /**
   * The rest of the card, read once the snapshot is sealed and the hash gate
   * missed. Sealing sheds graded slices from the snapshot IN PLACE when it is
   * over budget, and the series objects the snapshot carries are the card's
   * own, so whatever reads them (the steady-run count) reads them here, after
   * the shed, never before it.
   */
  finish(): StatusCardTail<I>;
}

/** The part of a card that is read after its snapshot is sealed. */
export interface StatusCardTail<I> {
  context: StatusContextInputs;
  /** The deterministic line, grounded in the card's signal when it has one. */
  fallbackText: string;
  prompts(
    snapshotJson: string,
    context: StatusPromptContext,
  ): { systemPrompt: string; userPrompt: string };
  detail: I;
}

/** A served early return from a card's snapshot stage. */
export interface ServedBuild<R extends StatusCardResult> {
  phase: "served";
  result: R;
}

/** One specialised card, as a plug-in to `prepareStatusCard`. */
export interface StatusCardPlugin<R extends StatusCardResult, I> {
  scope: InsightStatusMetric;
  codec: StatusNoteCodec<R, I>;
  /** The deterministic line a read-only miss serves when notes are unavailable. */
  unavailableText(locale: SupportedLocale): string;
  /** Thrown if a reply survives the screen with no text at all. */
  emptyMessage: string;
  build(ctx: StatusCardContext): Promise<StatusCardBuild<I> | ServedBuild<R>>;
}

/**
 * Everything up to (not including) the provider call, for one specialised
 * card. Returns a finished `served` result for every path that never needed
 * the LLM, or a `pending` descriptor the single-card path and the batch path
 * both drive. See `status-card-generation.ts` for the contract.
 */
export async function prepareStatusCard<R extends StatusCardResult, I>(
  plugin: StatusCardPlugin<R, I>,
  userId: string,
  options: StatusCardOptions | undefined,
): Promise<PreparedStatusCard> {
  const ctx = await openStatusCard(userId, plugin.scope, options);

  const cached = await readCachedStatus(ctx, plugin.codec);
  if (cached) return { phase: "served", result: cached };

  if (ctx.readOnly) {
    return {
      phase: "served",
      result: await resolveReadOnlyStatus(
        ctx,
        plugin.codec,
        plugin.unavailableText(ctx.locale),
      ),
    };
  }

  const build = await plugin.build(ctx);
  if ("phase" in build) return build;

  const { snapshotJson, snapshotHash } = await sealStatusSnapshot(
    ctx,
    build.snapshot,
  );
  const unchanged = await refreshUnchangedStatus(
    ctx,
    plugin.codec,
    snapshotHash,
  );
  if (unchanged) return { phase: "served", result: unchanged };

  const tail = build.finish();
  const context = await buildStatusPromptContext(ctx, tail.context);
  const { systemPrompt, userPrompt } = tail.prompts(snapshotJson, context);
  return pendingStatusCard(ctx, plugin.codec, {
    systemPrompt,
    userPrompt,
    hashes: {
      snapshotHash,
      ...(build.inputHash !== undefined ? { inputHash: build.inputHash } : {}),
    },
    temperature: STATUS_CARD_TEMPERATURE,
    fallbackText: tail.fallbackText,
    emptyMessage: plugin.emptyMessage,
    detail: tail.detail,
  });
}
