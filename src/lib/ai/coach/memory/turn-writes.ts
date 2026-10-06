/**
 * v1.41 — what a turn's tools keep, held until the answer is stored.
 *
 * `remember_fact` and `propose_plan` run in the middle of a turn, before the
 * answer has passed its guards. A fact or a plan written there outlived an
 * answer that was then blocked, failed or abandoned by the client: the fact
 * sat in memory without the note and its "Undo" ever reaching the person,
 * and the plan stayed listed, could be taken on, and flowed into later turns
 * and the briefing although the reply that proposed it was replaced.
 *
 * So the tools stage their write here under an id minted up front, and the
 * write happens in the transaction that stores the assistant message
 * (`appendMessage`), and only for what that message carries on its
 * provenance: the saved fact of `memoryNote`, the plan of `planProposal`. A
 * blocked answer carries neither, a failed or abandoned turn stores no
 * answer (or the empty `cancelled` marker), so nothing of theirs is written.
 * The same holds for a background proposal the turn offered: it counts as
 * offered (`last_used_at`) only once an answer carrying it is stored, so a
 * failed turn offers it again next time.
 *
 * Staged writes live in this process only: a turn runs, and stores its
 * answer, inside one request. An entry nobody claims lapses after
 * {@link STAGED_TTL_MS}.
 *
 * Server-only. Fact and plan text never reach a log.
 */
import { randomBytes } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";

import { encryptToBytes } from "../bytes-codec";
import type { CoachProvenance } from "../types";

/** How long an unclaimed staged write is kept. */
export const STAGED_TTL_MS = 30 * 60_000;

const MS_PER_DAY = 86_400_000;

/** The prefix of a proposal id minted in a turn (a pending row uses its id). */
export const TURN_PROPOSAL_PREFIX = "mp_";

export interface StagedFact {
  kind: "fact";
  userId: string;
  conversationId: string;
  fact: string;
  category: string;
  confidence: number;
  sourceMessageId: string;
  source: string;
}

export interface StagedPlan {
  kind: "plan";
  userId: string;
  conversationId: string;
  metric: string;
  ifCue: string;
  thenAction: string;
  target: string | null;
  reviewInDays: number;
}

type Staged = (StagedFact | StagedPlan) & { at: number };

const staged = new Map<string, Staged>();

/** A cuid-shaped id, so the row looks like every other. */
function mintId(): string {
  return `c${randomBytes(12).toString("hex")}`;
}

function sweep(now: number): void {
  for (const [id, entry] of staged) {
    if (now - entry.at > STAGED_TTL_MS) staged.delete(id);
  }
}

/** Stages a write and answers the id the row will carry. */
export function stageTurnWrite(entry: StagedFact | StagedPlan): string {
  const now = Date.now();
  sweep(now);
  const id = mintId();
  staged.set(id, { ...entry, at: now });
  return id;
}

/** Test seam: drop every staged write. */
export function resetStagedTurnWritesForTests(): void {
  staged.clear();
}

/** Drops everything staged for a conversation. */
function dropConversation(conversationId: string): void {
  for (const [id, entry] of staged) {
    if (entry.conversationId === conversationId) staged.delete(id);
  }
}

/**
 * Writes what the stored answer carries, inside its transaction, and drops
 * everything else the turn staged. Called for every assistant message.
 */
export async function commitTurnWrites(
  tx: Prisma.TransactionClient,
  args: {
    conversationId: string;
    provenance: CoachProvenance | null | undefined;
    now?: Date;
  },
): Promise<void> {
  const { conversationId, provenance } = args;
  const now = args.now ?? new Date();
  const note = provenance?.memoryNote;
  const plan = provenance?.planProposal;
  try {
    if (note && !note.proposal && note.factId) {
      const entry = staged.get(note.factId);
      if (entry?.kind === "fact" && entry.conversationId === conversationId) {
        // Field-by-field (no mass assignment).
        await tx.coachFact.create({
          data: {
            id: note.factId,
            userId: entry.userId,
            factEncrypted: encryptToBytes(entry.fact),
            category: entry.category,
            confidence: entry.confidence,
            sourceConversationId: conversationId,
            sourceMessageId: entry.sourceMessageId,
            source: entry.source,
          },
        });
      }
    }
    if (
      note?.proposal &&
      note.proposalId &&
      !note.proposalId.startsWith(TURN_PROPOSAL_PREFIX)
    ) {
      // A background proposal the answer offers: offered once, from now.
      // Raw so `updated_at` does not move. Bound parameters only.
      await tx.$executeRaw`
        UPDATE "coach_facts" AS f
        SET "last_used_at" = ${now}
        FROM "coach_conversations" AS c
        WHERE f."id" = ${note.proposalId}
          AND c."id" = ${conversationId}
          AND f."user_id" = c."user_id"
          AND f."source" = 'proposed'
          AND f."deleted_at" IS NULL`;
    }
    if (plan?.planId) {
      const entry = staged.get(plan.planId);
      if (entry?.kind === "plan" && entry.conversationId === conversationId) {
        await tx.coachPlan.create({
          data: {
            id: plan.planId,
            userId: entry.userId,
            metric: entry.metric,
            ifCueEncrypted: encryptToBytes(entry.ifCue),
            thenActionEncrypted: encryptToBytes(entry.thenAction),
            targetEncrypted: entry.target ? encryptToBytes(entry.target) : null,
            status: "proposed",
            // The proposed window until the person decides; the sweep only
            // reviews active plans.
            reviewDate: new Date(
              now.getTime() + entry.reviewInDays * MS_PER_DAY,
            ),
            sourceConversationId: conversationId,
          },
        });
      }
    }
  } finally {
    // The turn is over: whatever it staged and its answer did not carry is
    // gone with it.
    dropConversation(conversationId);
  }
}
