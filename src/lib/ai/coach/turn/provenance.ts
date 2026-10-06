/**
 * The provenance envelope a Coach reply is persisted and streamed with:
 * what the snapshot covered, plus what this turn added (key values, cards,
 * the tool trace, the grounded figures, the withheld-figure count, and the
 * dialog: steps, tables, method, chips, clarification).
 */
import { annotate } from "@/lib/logging/context";
import type { Locale } from "@/lib/i18n/config";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import type {
  CoachActivityMeta,
  CoachAssumption,
  CoachClarification,
  CoachFollowUp,
  CoachMemoryNote,
  CoachMethod,
  CoachPlanProposal,
  CoachProvenance,
  CoachResultMeta,
  CoachResultTable,
  CoachStep,
  CoachStop,
  CoachSuggestion,
} from "@/lib/ai/coach/types";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";
import type { CoachToolTrace } from "@/lib/ai/coach/tools";
import { buildMethod } from "@/lib/ai/coach/method";
import {
  assumptionFollowUps,
  deriveFollowUps,
  followUpChipsEnabled,
  type FollowUpHistory,
} from "@/lib/ai/coach/follow-ups/derive";
import { assumptionFromClarification } from "@/lib/ai/coach/clarify";
import { numberFollowUps } from "@/lib/ai/coach/follow-ups/catalog";
import { buildContinueFollowUp } from "@/lib/ai/coach/follow-ups/continue";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";
import { fitResultsToStorage } from "@/lib/ai/coach/results/refs";

import type { ModelOutcome } from "./model";
import type { GuardedReply } from "./reply-guards";

/** What the dialog adds to a guarded reply. */
export interface TurnDialog {
  /** The tables to stream and persist; empty on a blocked turn. */
  results: CoachResultTable[];
  method: CoachMethod | null;
  /** Empty on a blocked turn. */
  followUps: CoachFollowUp[];
  /** Null on a blocked turn. */
  clarification: CoachClarification | null;
  /** v1.41 — what the answer assumed instead of asking; empty on a blocked turn. */
  assumptions: CoachAssumption[];
  /** v1.41 — the fact the turn saved or proposes; null on a blocked turn. */
  memoryNote: CoachMemoryNote | null;
  /** v1.41 — the plan the turn proposes; null on a blocked turn. */
  planProposal: CoachPlanProposal | null;
}

/** At most this many assumptions per answer. */
export const MAX_ASSUMPTIONS = 2;

/** A table's metadata: everything but the values, for the plaintext blob. */
export function toResultMeta(table: CoachResultTable): CoachResultMeta {
  return {
    ref: table.ref,
    source: table.source,
    shape: table.shape,
    titleKey: table.titleKey,
    title: table.title,
    rowCount: table.rowCount,
    chartKind: table.chartKind,
    displayed: table.displayed,
    ...(table.reusedFrom ? { reusedFrom: table.reusedFrom } : {}),
    ...(table.view ? { view: table.view } : {}),
  };
}

/**
 * v1.39.4 — the dialog of a guarded reply. On an outbound block the tables,
 * chips and clarification are dropped, the way key values already are: the
 * reply they belonged to was replaced.
 */
export function assembleTurnDialog(args: {
  model: Extract<ModelOutcome, { ok: true }>;
  reply: GuardedReply;
  prefs: CoachPrefs;
  locale: Locale;
  /** The record's history for the tables' metrics, for the history chips. */
  history?: FollowUpHistory;
  /** The forced reply this turn continues, if it does. */
  continuationOf?: string;
}): TurnDialog {
  const { model, reply, prefs, locale } = args;
  const blocked = reply.outboundBlocked;
  const referenced = new Set(reply.referencedResults);
  // Fitted to the at-rest ceiling here, before anything streams, so the
  // tables shown live, the metadata and the ciphertext name the same set: a
  // table trimmed only at write time showed live and read back withheld.
  const results = blocked
    ? []
    : fitResultsToStorage(
        model.results.map((table) =>
          referenced.has(table.ref) ? { ...table, displayed: true } : table,
        ),
      );
  const metas = results.map(toResultMeta);
  const method = buildMethod({ steps: model.steps, results: metas, locale });
  // No chips on a blocked turn, when the pref is off, or under a clarifying
  // question: its choices are the next step, and chips beside them would
  // compete with the answer the question waits for.
  const offerChips =
    !blocked && followUpChipsEnabled(prefs) && reply.clarification === null;
  // v1.41 — a question the brake declined became an assumption; the answer
  // names it, and its alternatives are one tap away.
  const assumptions = blocked
    ? []
    : model.declinedClarifications
        .map(assumptionFromClarification)
        .filter((a): a is CoachAssumption => a !== null)
        .slice(0, MAX_ASSUMPTIONS);
  const continueChip = offerChips
    ? buildContinueFollowUp({
        forcedFinal: model.forcedFinal,
        continuationOf: args.continuationOf,
        locale,
      })
    : null;
  const followUps = offerChips
    ? numberFollowUps([
        ...(continueChip ? [continueChip] : []),
        ...assumptionFollowUps({ assumptions, prefs, locale }),
        ...deriveFollowUps({
          results: metas,
          steps: model.steps,
          inventory: model.inventory,
          proposals: reply.followUpProposals,
          forcedFinal: model.forcedFinal,
          prefs,
          locale,
          history: args.history,
          correlations: model.correlations,
        }),
      ])
    : [];
  return {
    results,
    method,
    followUps,
    clarification: reply.clarification,
    assumptions,
    // The note and the proposal belong to the reply they came with; a
    // blocked reply was replaced, so they do not ride along.
    memoryNote: blocked ? null : model.memoryNote,
    planProposal: blocked ? null : model.planProposal,
  };
}

/** The persisted half of a fact note: no fact text. */
function memoryNoteMeta(note: CoachMemoryNote): CoachProvenance["memoryNote"] {
  return {
    proposal: note.proposal,
    ...(note.proposalId ? { proposalId: note.proposalId } : {}),
    ...(note.factId ? { factId: note.factId } : {}),
    category: note.category,
  };
}

/** The persisted half of a plan proposal: no plan text. */
function planProposalMeta(
  proposal: CoachPlanProposal,
): CoachProvenance["planProposal"] {
  return {
    planId: proposal.planId,
    metric: proposal.metric,
    reviewInDays: proposal.reviewInDays,
  };
}

export function buildTurnProvenance(args: {
  snapshotProvenance: CoachProvenance;
  reply: GuardedReply;
  suggestion: CoachSuggestion | null;
  action: CoachSuggestedAction | null;
  toolTrace: CoachToolTrace[];
  /** v1.39.4 — the steps the turn read; kept on a blocked turn too. */
  steps: CoachStep[];
  dialog: TurnDialog;
  forcedFinal: boolean;
  /** v1.39.4 — the forced reply this turn continues, if it does. */
  continuationOf?: string;
  /** v1.41 — the trail's plaintext metadata. */
  activity?: CoachActivityMeta[];
  /** v1.41 — why the answer was forced, when it was. */
  stop?: CoachStop;
}): CoachProvenance {
  const { snapshotProvenance, reply, toolTrace, steps, dialog } = args;
  const surfacedSuggestion = args.suggestion;
  const surfacedAction = args.action;
  const sentinel = reply.keyValuesSentinel;
  const outboundBlocked = reply.outboundBlocked;
  const { groundedFigures, unverifiedStripped } = reply;

  const enrichedProvenance: CoachProvenance = {
    ...snapshotProvenance,
    ...(surfacedAction ? { suggestedAction: surfacedAction } : {}),
    // v1.18.10 (HIGH-2) — a blocked turn carries the fallback prose, so the
    // key-values from the discarded reply must not ride along as provenance.
    ...(!outboundBlocked && sentinel.keyValues.length > 0
      ? { keyValues: sentinel.keyValues }
      : {}),
    ...(surfacedSuggestion ? { suggestion: surfacedSuggestion } : {}),
    // v1.20.0 (F1) — persist the retrieval-tool trace (which tools ran +
    // whether each found data) so a reload can show "what I looked at" and the
    // audit can replay grounding. Metadata only.
    ...(toolTrace.length > 0
      ? {
          toolCalls: toolTrace.map((t) => ({
            name: t.name,
            present: t.present,
          })),
        }
      : {}),
    // v1.32.9 (Coach Guard II / G2) — persist THIS turn's tool figures so a
    // later turn's Grounding Ledger can recall them (D3-safe: tool trace, not
    // prose). Dropped on a blocked turn (its figures rode the discarded reply).
    ...(!outboundBlocked && groundedFigures.length > 0
      ? { groundedFigures }
      : {}),
    // v1.32.14 — the count of figures the grounding guard withheld this turn,
    // so the quiet "some figures couldn't be checked" notice renders under the
    // bubble and survives a conversation reload. Count only, no values. Omitted
    // when nothing was withheld.
    ...(unverifiedStripped > 0
      ? { unverifiedFigures: unverifiedStripped }
      : {}),
    // v1.39.4 — the dialog. Metadata only: a table's values are in the
    // encrypted column, never in this plaintext envelope.
    ...(steps.length > 0 ? { steps } : {}),
    ...(dialog.method ? { method: dialog.method } : {}),
    ...(dialog.results.length > 0
      ? { results: dialog.results.map(toResultMeta) }
      : {}),
    ...(dialog.followUps.length > 0 ? { followUps: dialog.followUps } : {}),
    ...(dialog.clarification ? { clarification: dialog.clarification } : {}),
    ...(args.forcedFinal ? { forcedFinal: true as const } : {}),
    ...(args.continuationOf ? { continuationOf: args.continuationOf } : {}),
    // v1.41 — the trail, the stop, the assumptions, the note and the plan.
    // Metadata only: model and fact text live in `trail_encrypted`.
    ...(args.activity && args.activity.length > 0
      ? { activity: args.activity }
      : {}),
    ...(args.stop ? { stop: args.stop } : {}),
    ...(dialog.assumptions.length > 0
      ? { assumptions: dialog.assumptions }
      : {}),
    ...(dialog.memoryNote
      ? { memoryNote: memoryNoteMeta(dialog.memoryNote) }
      : {}),
    ...(dialog.planProposal
      ? { planProposal: planProposalMeta(dialog.planProposal) }
      : {}),
  };
  if (sentinel.malformed) {
    // Graceful degrade: log so ops can spot a provider whose
    // sentinel format has drifted, but pass the prose through
    // unchanged. v1.4.23 H1 — split the annotation:
    //   - parse_partial: at least one row parsed AND at least one
    //     row failed (mixed-format drift on a single reply)
    //   - parse_failed: the whole block was unusable
    // Both annotations carry the per-line `reasons` array so an ops
    // dashboard can attribute the failure cause without re-running
    // the parser.
    const reasons = sentinel.malformedEntries.map((entry) => entry.reason);
    const annotationName =
      sentinel.keyValues.length > 0 && sentinel.malformedEntries.length > 0
        ? "coach.keyvalues.parse_partial"
        : "coach.keyvalues.parse_failed";
    annotate({
      action: { name: annotationName },
      meta: {
        kept: sentinel.keyValues.length,
        malformedCount: sentinel.malformedEntries.length,
        reasons,
        promptVersion: PROMPT_VERSION,
      },
    });
  }
  return enrichedProvenance;
}
