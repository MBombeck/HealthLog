/**
 * Every guard a Coach reply passes before a byte of it reaches the client:
 * the sentinel strips (KEYVALUES, SUGGEST-REMINDER, REMEMBER, SUGGEST-ACTION),
 * the outbound safety screen, the grounding ledger, the empty-record
 * replacement, and the learn-link scrub.
 */
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import {
  screenCoachReply,
  coachOutboundFallback,
} from "@/lib/ai/coach/outbound-guard";
import { parseKeyValuesSentinel } from "@/lib/ai/coach/keyvalues";
import {
  findUnverifiedCoachNumbersInLedger,
  stripUnverifiedNumbers,
} from "@/lib/ai/coach/coach-prose-grounding";
import {
  buildGroundingLedger,
  figuresForPersistence,
} from "@/lib/ai/coach/grounding-ledger";
import { scrubUnknownLearnLinks } from "@/lib/ai/coach/learn-link-guard";
import { parseSuggestReminder } from "@/lib/ai/coach/suggest-reminder";
import {
  parseRememberSentinel,
  captureReminderFromSentinel,
} from "@/lib/ai/coach/reminders";
import { parseSuggestAction } from "@/lib/ai/coach/suggest-action";
import {
  dropRepeatClarification,
  parseClarifySentinel,
} from "@/lib/ai/coach/clarify";
import { parseFollowUpsSentinel } from "@/lib/ai/coach/follow-ups/parse-sentinel";
import { stripResultRefs } from "@/lib/ai/coach/results/refs";
import type { CoachClarification } from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";

import type { TurnContext } from "./context";
import type { ModelOutcome } from "./model";
import type { TurnConversation } from "./types";

export interface GuardedReply {
  replyText: string;
  keyValuesSentinel: ReturnType<typeof parseKeyValuesSentinel>;
  suggestParse: ReturnType<typeof parseSuggestReminder>;
  actionParse: ReturnType<typeof parseSuggestAction>;
  /** True when the outbound screen replaced the reply with its fallback. */
  outboundBlocked: boolean;
  groundedFigures: number[];
  unverifiedStripped: number;
  /** v1.39.4 — the refs (`r1`..) the prose marked as the tables it uses. */
  referencedResults: string[];
  /** v1.39.4 — the chip kinds and domains the model proposed. */
  followUpProposals: ReturnType<typeof parseFollowUpsSentinel>["proposals"];
  /**
   * v1.39.4 — the validated clarification, when this reply asks one. Null
   * when it does not, and on a blocked turn (the question was replaced).
   */
  clarification: CoachClarification | null;
}

/**
 * The metrics a no-tools turn's snapshot covered, as inventory rows the
 * clarification filter reads. Present by construction: the snapshot carried
 * them.
 */
function snapshotInventory(ctx: TurnContext): InventoryEntry[] {
  return ctx.snapshot.provenance.metrics
    .filter((metric) => metric !== "general")
    .map((metric) => ({
      tool: "get_metric_series",
      domain: metric,
      present: true,
      metric,
    }));
}

export async function guardReply(args: {
  userId: string;
  locale: Locale;
  conversation: TurnConversation;
  ctx: TurnContext;
  toolMode: boolean;
  model: Extract<ModelOutcome, { ok: true }>;
}): Promise<{ ok: true; reply: GuardedReply } | { ok: false; code: string }> {
  const { userId, locale, conversation, ctx, toolMode, model } = args;
  const workingConversationId = conversation.conversationId;
  const { toolTrace, toolResultPayloads } = model;

  const rawReply = (model.result.content ?? "").trim();
  if (!rawReply) {
    return { ok: false, code: "coach.provider.empty" };
  }

  // v1.4.22 — strip the optional `---KEYVALUES---` … `---END---`
  // sentinel out of the prose. The stripped prose is what we stream
  // to the client and persist; the parsed entries enrich the
  // provenance envelope so the UI can render the collapsible
  // "Worauf bezieht sich das?" disclosure.
  const sentinel = parseKeyValuesSentinel(rawReply);
  const proseAfterStrip = sentinel.prose.trim();
  // v1.4.22 W5 reconcile (Code-H1) — when the model emits a
  // sentinel-only / malformed reply, `sentinel.prose` is empty after
  // stripping. The previous fallback `sentinel.prose.trim() || rawReply`
  // surfaced raw `---KEYVALUES---` markers to the user. The empty-prose
  // condition signals an unusable provider response: short-circuit to
  // the structured `coach.provider.empty` error frame instead of
  // streaming the raw sentinel body.
  if (!proseAfterStrip) {
    annotate({
      action: { name: "coach.keyvalues.parse_failed" },
      meta: {
        kept: sentinel.keyValues.length,
        reason: "empty_prose_after_strip",
        promptVersion: PROMPT_VERSION,
      },
    });
    return { ok: false, code: "coach.provider.empty" };
  }
  // v1.18.1 (Workstream C) — strip the optional `---SUGGEST-REMINDER---`
  // block out of the prose-after-keyvalues. The model proposes a cadence;
  // the gate decides whether it actually surfaces (module-toggle + opt-out
  // + dismissal memory + cooldown + dedup against a live COACH reminder).
  // A suppressed proposal leaves the prose unchanged and emits no card.
  const suggestParse = parseSuggestReminder(proseAfterStrip);
  let replyText = suggestParse.prose.trim() || proseAfterStrip;

  // v1.22 (B2) — strip the optional `---REMEMBER---` block and capture the
  // reminder INLINE on this turn (not in the >20-turn memory worker), so a
  // casual "remind me about X" in a SHORT chat is no longer lost. A missing
  // note / invalid `when` drops the block (the user never sees the raw
  // marker). Fire-and-forget: the capture write must never break the turn.
  //
  // v1.30.25 — the capture writes `proposed`, not `active`. The block is
  // model output, and the model reads a prompt carrying document-sourced
  // text, so the write needs the same propose-then-confirm moat every other
  // model-driven write already has. See `captureReminderFromSentinel`.
  const rememberParse = parseRememberSentinel(replyText, new Date());
  replyText = rememberParse.prose.trim() || replyText;
  if (rememberParse.reminder) {
    const capture = rememberParse.reminder;
    void captureReminderFromSentinel({
      userId,
      conversationId: workingConversationId,
      parsed: capture,
    }).catch(() => {
      // Reminder capture is best-effort; never sink the turn.
    });
  } else if (rememberParse.malformed) {
    annotate({
      action: { name: "coach.reminder.capture_malformed" },
      meta: { conversationId: workingConversationId },
    });
  }

  // v1.22 (F6) — strip the optional `---SUGGEST-ACTION---` block (the
  // generalised confirm→apply moat). The model names ONE action from the closed
  // allowlist (`checkup.create` / `reminder.note`); the card surfaces additively
  // and NOTHING is created until the user taps confirm (the entity is built
  // server-side, field-by-field, by `POST /api/coach/suggested-actions`).
  const actionParse = parseSuggestAction(replyText);
  replyText = actionParse.prose.trim() || replyText;

  // v1.39.4 — the dialog sentinels and marks, stripped before the safety
  // screen and the number check read the prose: the optional
  // `---FOLLOWUPS---` proposal, the optional `---CLARIFY---` block, and the
  // `result:rN` marks (whose digits must never reach the number check).
  const followUpsParse = parseFollowUpsSentinel(replyText);
  replyText = followUpsParse.prose.trim() || replyText;
  const clarifyParse = parseClarifySentinel({
    prose: replyText,
    // v1.41 — the no-tools path has no inventory; the metrics its snapshot
    // covered stand in for one, so a metric question can still be asked.
    inventory: model.inventory ?? snapshotInventory(ctx),
    locale,
  });
  // A block with no question before it leaves nothing to show; the raw
  // marker must never reach the person, so that reply is unusable.
  replyText = clarifyParse.prose.trim();
  if (!replyText) return { ok: false, code: "coach.provider.empty" };
  // v1.41 — a question asked through `ask_clarification` is the reply
  // itself, validated and braked when it was asked; the sentinel stays the
  // no-tools path's way to ask.
  const clarification = await dropRepeatClarification({
    userId,
    conversationId: workingConversationId,
    clarification:
      model.toolClarification?.clarification ?? clarifyParse.clarification,
    latest: conversation.latestMessages,
  });
  const resultRefs = stripResultRefs(replyText);
  replyText = resultRefs.prose.trim() || replyText;

  // v1.18.10 (HIGH-2) — OUTBOUND safety screen on the assembled assistant
  // reply, before persistence and streaming. The inbound `detectRefusal`
  // guards the user's message; this guards the model's reply for a
  // dose-prescription or a fabricated clinical risk score that slipped past
  // the system-prompt GLP-1/grounding contracts. On a trip the turn is
  // replaced with a calm, grounded fallback and any reminder suggestion /
  // key-value provenance is dropped — the user never sees the unsafe text.
  const outbound = screenCoachReply(replyText, locale, ctx.scheduleDoses);
  if (outbound.block && outbound.reason) {
    replyText = coachOutboundFallback(outbound.reason, locale);
    annotate({
      action: { name: "insights.coach.outbound_blocked" },
      meta: { reason: outbound.reason, promptVersion: PROMPT_VERSION },
    });
    await auditLog("insights.coach.outbound_blocked", {
      userId,
      details: {
        conversationId: workingConversationId,
        reason: outbound.reason,
      },
    });
  }

  // v1.21.0 (P6 / C2-5) — post-hoc numeric verifier on the Coach prose. Cross-
  // check every number the model cited against this turn's authoritative figure
  // set; an unmatched number (transcription / paraphrase drift) is soft-stripped
  // to the editorial elision mark `[…]` and annotated (v1.32.14 — the withheld
  // count also rides the provenance envelope to drive the per-message notice).
  // Cheap, non-blocking, and a no-op when there
  // is no authoritative set — the prompt-level grounding rule remains the
  // backstop, exactly like the briefing's "no signals → skip". A blocked turn
  // already carries canned fallback prose, so skip it.
  //
  // v1.21.2 (A8) — the authoritative set is the figures the tools returned on the
  // tool path, and the SNAPSHOT the model was shown on the no-tools/local path
  // (`snapshot.sections`, which already carries the correlations-snapshot block).
  // Exactly one is populated per turn; the grading, tolerance, and exemptions are
  // identical, so a number the model invents is flagged the same way on both.
  // v1.32.9 (Coach Guard II / G2+G3) — grade the prose against the typed
  // Grounding Ledger rather than a per-turn magnitude bag. Activation is
  // unchanged from Guard I: the ledger is graded ONLY when THIS turn delivered
  // fresh figures the model was told to ground against (a present tool result
  // / pinned workout, or the full snapshot on the no-tools path). The
  // cross-turn, memory, schedule, reference, and guided sources only WIDEN an
  // active grading — they never ACTIVATE it, so a snapshot figure the model
  // cited on a no-tool turn is still left alone (the v1.32.1 regression guard
  // holds). Assistant prose is never a ledger source (D3).
  //
  // The turn that CALLED tools and got nothing back is graded too. It used to
  // be the one turn the verifier sat out: a pure miss carries no `data` and no
  // `available`, `runCoachToolLoop` drops that shape from `toolResults`, and
  // the no-tools snapshot fallback below is populated only in the non-tool
  // branch — so `activatingPayloads` came out empty and every figure in the
  // reply shipped unchecked. That is backwards. A turn whose every tool
  // reported `{ present: false }` is not an absence of evidence about the
  // reply, it is evidence that the record holds nothing to cite, which is
  // exactly when a fabricated figure is both likeliest and most harmful.
  //
  // `toolTrace` is the discriminant, because it records every tool that ran
  // INCLUDING the pure misses. It separates the two cases the old condition
  // conflated: tools ran and found nothing (grade — the model was told the
  // record is empty and answered with numbers anyway), versus the model
  // answered without calling a tool at all (stay dormant — the v1.32.1
  // regression, where the base prompt deliberately carries no pre-computed
  // figures and flagging a legitimately recalled one was a real defect).
  const missedEveryTool =
    toolMode && toolTrace.length > 0 && toolResultPayloads.length === 0;
  const activatingPayloads =
    toolResultPayloads.length > 0
      ? toolResultPayloads
      : missedEveryTool
        ? model.inventoryPayloads
        : model.noToolsSnapshotPayloads;
  let groundedFigures: number[] = [];
  // v1.32.14 — count of figures withheld from THIS reply (each rewritten to the
  // elision mark). Hoisted out of the guard block so it can ride the provenance
  // envelope and drive the quiet per-message notice. Stays 0 on a blocked turn
  // (the guard is skipped, its fallback prose carries no figures).
  let unverifiedStripped = 0;
  // True when the guard stripped a figure on a turn whose every tool missed —
  // i.e. the model put a number on a record that holds none. Drives the
  // honest-replacement below.
  let fabricatedOnEmptyRecord = false;
  if (activatingPayloads.length > 0 || missedEveryTool) {
    const ledger = buildGroundingLedger({
      toolPayloads: activatingPayloads,
      priorToolFigures: conversation.priorToolFigures,
      priorUserMessages: conversation.priorUserMessages,
      // The self-context (goals / about-me) rides the system prompt on both
      // paths — the ledger's `memory` source.
      memoryTexts: ctx.aboutMe ? [ctx.aboutMe] : [],
      scheduleDoses: ctx.scheduleDoses,
      // Reference grounding rides the prompt only on the no-tools
      // full-snapshot path; the guided block rides both paths.
      referenceGrounding:
        !toolMode && ctx.turnContext.includeFullSnapshot
          ? ctx.snapshot.referenceGrounding
          : null,
      guidedBlock: ctx.turnContext.guidedBlock,
    });
    // Persist THIS turn's tool figures (bare magnitudes) so a LATER turn can
    // recall them via the ledger — D3: the tool trace, never the prose.
    groundedFigures = figuresForPersistence(ledger);
    if (!outbound.block) {
      const unverified = findUnverifiedCoachNumbersInLedger(
        replyText,
        ledger,
        locale,
        // On an all-missed turn an EMPTY ledger is the finding, not a reason
        // to skip: nothing was retrievable, so nothing can reconcile.
        { gradeAgainstEmptyLedger: missedEveryTool },
      );
      if (unverified.length > 0) {
        const { prose: corrected, stripped } = stripUnverifiedNumbers(
          replyText,
          unverified,
        );
        replyText = corrected;
        unverifiedStripped = stripped;
        fabricatedOnEmptyRecord = missedEveryTool && stripped > 0;
        annotate({
          action: { name: "coach.prose.number_unverified" },
          meta: {
            flagged: unverified.length,
            stripped,
            // No raw values — just the count + truncated tokens for ops triage.
            tokens: unverified.slice(0, 6).map((u) => u.source),
            promptVersion: PROMPT_VERSION,
          },
        });
      }
    }
  }

  // A stripped reply on an empty record is not worth sending. Eliding the
  // digits leaves the sentences that carried them — "your sleep averaged […]
  // minutes, up from […]" still asserts a series, an average and a direction
  // for a metric the tools just reported has no readings at all. The false
  // claim survives the strip; only its precision goes. So replace the turn
  // with the honest answer instead of shipping the elided mush.
  //
  // Scoped tightly: this fires only when every tool missed AND the guard
  // actually stripped something. A reply that cited a legitimately grounded
  // figure (a prior turn's tool result, an inventory count) reconciles
  // against the ledger, strips nothing, and is left alone.
  //
  // REPLACE, not withhold — the same policy the outbound screen uses on this
  // surface, for the same reason: the user is waiting on a synchronous answer
  // and silence reads as a failure.
  //
  // Accepted trade-off: a reply mixing one grounded recall with one
  // fabrication is replaced wholesale, losing the good half. That is the
  // right way round — the alternative leaves an invented figure's sentence
  // on screen.
  if (fabricatedOnEmptyRecord) {
    replyText = getServerTranslator(locale).t("coach.noRecordedData");
    // The reply now carries no figures at all, so the withheld-figure notice
    // would be describing prose the reader can no longer see. The replacement
    // copy states the same thing in plain words.
    unverifiedStripped = 0;
    annotate({
      action: { name: "coach.prose.empty_record_replaced" },
      meta: { promptVersion: PROMPT_VERSION },
    });
    await auditLog("insights.coach.empty_record_replaced", {
      userId,
      details: { conversationId: workingConversationId },
    });
  }

  // v1.21.0 (NEW-C C-3) — Learn-link post-filter. The prompt instructs the
  // model to only link a published `/learn/<slug>`, but that is guidance, not
  // enforcement: a fabricated `/learn/<invented-slug>` would otherwise ship as
  // a dead link. Scrub any reference whose slug is not in the catalog (a real
  // one is kept verbatim). A blocked turn carries canned fallback prose with no
  // links, so skip it.
  if (!outbound.block && replyText.includes("/learn/")) {
    const scrubbed = scrubUnknownLearnLinks(replyText);
    if (scrubbed.dropped.length > 0) {
      replyText = scrubbed.text;
      annotate({
        action: { name: "coach.learn.link_dropped" },
        meta: {
          dropped: scrubbed.dropped.length,
          // Truncated slug tokens for ops triage — no user content.
          slugs: scrubbed.dropped.slice(0, 6),
          promptVersion: PROMPT_VERSION,
        },
      });
    }
  }

  return {
    ok: true,
    reply: {
      replyText,
      keyValuesSentinel: sentinel,
      suggestParse,
      actionParse,
      outboundBlocked: outbound.block,
      groundedFigures,
      unverifiedStripped,
      referencedResults: resultRefs.referenced,
      followUpProposals: followUpsParse.proposals,
      // A blocked turn carries the fallback prose, so a question it asked is
      // gone and its choices must not ride along.
      clarification: outbound.block ? null : clarification,
    },
  };
}
