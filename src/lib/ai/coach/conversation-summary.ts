/**
 * v1.11.1 (Epic B, B-W5b) — Coach conversation-summary COMPUTE module.
 *
 * A rolling, encrypted natural-language summary of the turns BEFORE the most
 * recent `RECENT_HISTORY` window. When a conversation grows past `TURN_CAP`
 * the chat route folds the older turns into a single synthetic line; today
 * that line is a dead placeholder. This module produces a durable summary the
 * route can substitute for the placeholder so the Coach keeps memory of the
 * elided turns.
 *
 * Structural sibling of `period-narrative-generate.ts`:
 *  - freshness short-circuit before any provider call,
 *  - `runStatusCompletion` over the user's provider chain (NOT hand-rolled),
 *  - `encryptToBytes` → `update` of the single conversation row,
 *  - `annotate` carries counts + ids only, never the summary content.
 *
 * Background generation is intentionally UNBILLED — like the period-narrative
 * warm, it books no spend of its own. The operator's per-user daily token
 * ceiling is the cost backstop; the interactive reply meter is not charged for
 * background memory upkeep.
 *
 * Fail-closed crypto: an undecryptable prior summary is treated as absent
 * (regenerate from scratch) and never allowed to throw into the caller.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  runStatusCompletion,
  type StatusProviderResult,
} from "@/lib/insights/status-provider";

import { decryptFromBytes, encryptToBytes } from "./bytes-codec";

/**
 * Safety cap on the stored summary length (~150 tokens). The prompt asks for
 * a short paragraph; this backstops a misbehaving provider so the encrypted
 * column + the next prompt's history window stay bounded.
 */
const SUMMARY_TARGET_CHARS = 600;

/** Re-summarise only once at least this many new turns accumulate. */
export const SUMMARY_REFRESH_TURN_DELTA = 6;

/**
 * Mirror of the chat route's history-window constants (`route.ts:75-76`).
 * Defined locally — the route is a 600+ LOC server module we must not import
 * from here. Keep in sync with the route by hand if either changes.
 */
const TURN_CAP = 20;
const RECENT_HISTORY = 18;

/** Injected provider-completion shape (defaults to the real chain runner). */
type RunCompletion = typeof runStatusCompletion;

export interface RefreshConversationSummaryOptions {
  now?: Date;
  runCompletion?: RunCompletion;
  prisma?: Pick<PrismaClient, "coachConversation" | "$executeRaw">;
  locale?: "de" | "en";
}

export type RefreshConversationSummaryResult = {
  status: "fresh" | "generated" | "skipped" | "insufficient";
};

/** A conversation turn folded into the summary (role-prefixed in the prompt). */
export interface SummaryFoldTurn {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT_EN = `You compress a coaching conversation into a durable rolling summary for the assistant's own future memory. Write 2-4 sentences (<= ~120 words) of plain prose. Capture: what the user is working on or worried about, any goals or preferences they stated, decisions or agreements reached, and open threads to follow up. Be descriptive, never diagnostic — record what was said, do not infer conditions. EXCLUDE: one-off pleasantries, exact numbers (those live in the live snapshot), anything the user asked you to forget, and any detail not useful to continuing the conversation. If a PRIOR SUMMARY is supplied, MERGE the new turns into it and return the merged summary — do not append; rewrite the whole thing concisely. Output only the summary prose, no preamble.`;

const SYSTEM_PROMPT_DE = `Du verdichtest ein Coaching-Gespräch zu einer dauerhaften, fortlaufenden Zusammenfassung für das eigene künftige Gedächtnis des Assistenten. Schreibe 2-4 Sätze (<= ~120 Wörter) in einfacher Prosa. Erfasse: woran die Person arbeitet oder was sie beschäftigt, genannte Ziele oder Vorlieben, getroffene Entscheidungen oder Vereinbarungen und offene Punkte zum Nachfassen. Sei beschreibend, nie diagnostisch — halte fest, was gesagt wurde, leite keine Erkrankungen ab. AUSSCHLIESSEN: einmalige Höflichkeiten, exakte Zahlen (die stehen im Live-Snapshot), alles, worum die Person dich zu vergessen gebeten hat, und jedes Detail, das für die Fortsetzung des Gesprächs nicht nützlich ist. Wenn eine FRÜHERE ZUSAMMENFASSUNG vorliegt, FÜGE die neuen Wortwechsel in sie EIN und gib die zusammengeführte Fassung zurück — nicht anhängen; schreibe das Ganze knapp neu. Gib nur die Zusammenfassungsprosa aus, ohne Vorrede.`;

/**
 * Build the user prompt fed to the model from the prior summary (when any) and
 * the turns being folded in. Exported so tests can assert the merge path
 * carries the prior summary into the prompt.
 */
export function buildSummaryUserPrompt(
  priorSummary: string | null,
  foldedTurns: SummaryFoldTurn[],
  locale: "de" | "en" = "en",
): string {
  const priorLabel =
    locale === "de" ? "FRÜHERE ZUSAMMENFASSUNG" : "PRIOR SUMMARY";
  const turnsLabel = locale === "de" ? "NEUE WORTWECHSEL" : "NEW TURNS";
  const none = locale === "de" ? "(keine)" : "(none)";

  const priorBlock =
    priorSummary && priorSummary.trim().length > 0 ? priorSummary.trim() : none;

  const turnsBlock = foldedTurns
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");

  return `${priorLabel}\n${priorBlock}\n\n${turnsLabel}\n${turnsBlock}`;
}

/**
 * Decrypt the prior summary fail-closed: a missing or undecryptable row yields
 * `null` so the caller regenerates from scratch rather than throwing into a
 * background job (mirrors `readPeriodNarrative`'s undecryptable-as-absent rule).
 */
function decryptPriorSummary(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch {
    return null;
  }
}

/**
 * (Re)compute the rolling summary for one conversation.
 *
 * Ownership-scoped: a conversation not owned by `userId` is treated as absent
 * (`"insufficient"`). Best-effort: a no-provider / timeout / error completion
 * leaves any existing summary untouched and returns `"skipped"`.
 */
export async function refreshConversationSummary(
  conversationId: string,
  userId: string,
  opts?: RefreshConversationSummaryOptions,
): Promise<RefreshConversationSummaryResult> {
  const now = opts?.now ?? new Date();
  const prisma = opts?.prisma ?? defaultPrisma;
  const runCompletion = opts?.runCompletion ?? runStatusCompletion;
  const locale = opts?.locale ?? "en";

  // 1. Ownership-scoped load. Decrypt every message body for the fold slice.
  const conversation = await prisma.coachConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      summaryEncrypted: true,
      summaryTurnCount: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { role: true, encryptedContent: true },
      },
    },
  });
  if (!conversation) {
    return { status: "insufficient" };
  }

  const turns = conversation.messages;
  const turnCount = turns.length;

  // 2. Cheap short-circuit: nothing has been elided yet — the live window
  //    already carries the whole conversation.
  if (turnCount <= TURN_CAP) {
    return { status: "insufficient" };
  }

  // The high-water mark of turns this refresh would fold: everything before
  // the most-recent `RECENT_HISTORY` window (same slice the route elides).
  const foldHighWater = turnCount - RECENT_HISTORY;

  // 3. Don't pay a provider call for a couple of new turns.
  if (
    conversation.summaryTurnCount > 0 &&
    foldHighWater - conversation.summaryTurnCount < SUMMARY_REFRESH_TURN_DELTA
  ) {
    return { status: "fresh" };
  }

  // 4. Decrypt prior summary (fail-closed) + the older turns to fold.
  const priorSummary = decryptPriorSummary(conversation.summaryEncrypted);
  const foldedTurns: SummaryFoldTurn[] = turns
    .slice(0, foldHighWater)
    .flatMap((m) => {
      let content: string;
      try {
        content = decryptFromBytes(m.encryptedContent);
      } catch {
        // Skip an undecryptable message (e.g. a row mid key-rotation) instead
        // of throwing and permanently stalling this conversation's summary —
        // fail-closed like every other decrypt in the Coach stack.
        return [];
      }
      // #781 — skip empty bodies: a cancelled-turn marker (an empty
      // assistant row closing an aborted turn) carries no content to fold.
      if (!content.trim()) return [];
      return [{ role: m.role === "assistant" ? "assistant" : "user", content }];
    });

  // 5. Run the user's provider chain. Best-effort: non-ok leaves the old
  //    summary in place.
  const completion: StatusProviderResult = await runCompletion({
    userId,
    cacheAction: "coach.summary",
    capability: "coach",
    systemPrompt: locale === "de" ? SYSTEM_PROMPT_DE : SYSTEM_PROMPT_EN,
    userPrompt: buildSummaryUserPrompt(priorSummary, foldedTurns, locale),
    temperature: 0.3,
    maxTokens: 200,
  });

  if (completion.kind !== "ok") {
    return { status: "skipped" };
  }

  const trimmed = completion.content.trim();
  if (trimmed.length === 0) {
    return { status: "skipped" };
  }
  // v1.32.20 — deliberately NOT routed through `screenModelOutput`. This
  // summary is internal memory only: it is stored encrypted and read back
  // solely as `priorSummary` to prime the NEXT summary/chat prompt
  // (`persistence.ts` decrypt → `chat/route.ts` priorSummary). It is never
  // rendered to a user surface. Any dose/risk/causal phrasing it might carry
  // cannot reach a person here, and the next Coach reply that could echo it is
  // itself screened (`screenCoachReply` in the chat route) before it ships.
  // Screening here would only risk withholding a legitimate internal summary
  // (memory loss) with no user-facing safety gain — so the screen stays on the
  // rendering boundaries, not this internal-memory write.
  // Backstop the stored length even if the provider over-ran the prompt's
  // "short paragraph" instruction.
  const text =
    trimmed.length > SUMMARY_TARGET_CHARS
      ? trimmed.slice(0, SUMMARY_TARGET_CHARS)
      : trimmed;

  // 6. Encrypt + persist. Field-by-field data object (no spread).
  const summaryEncrypted = encryptToBytes(text);
  // Raw SQL on purpose: a Prisma `update` stamps `updatedAt`, and the Coach
  // panel orders and groups conversations by it. A memory rewrite is
  // bookkeeping, not activity, so it must not move the thread to "Today".
  // Every value is a bound parameter.
  await prisma.$executeRaw`
    UPDATE "coach_conversations"
    SET "summary_encrypted" = ${summaryEncrypted},
        "summary_updated_at" = ${now},
        "summary_turn_count" = ${foldHighWater}
    WHERE "id" = ${conversationId}`;

  // 7. Counts + ids only — never the summary text.
  annotate({
    action: { name: "coach.summary.generated" },
    meta: { foldedTurns: foldHighWater, conversationId },
  });

  return { status: "generated" };
}
