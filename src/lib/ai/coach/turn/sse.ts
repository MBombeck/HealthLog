/**
 * The Coach chat wire: SSE framing, the keepalive heartbeat, the token
 * cadence, and the three stream shapes a turn can answer with (a guarded
 * reply, a refusal, a structured error).
 *
 * Imports nothing from the tool registry or the snapshot builder, so a
 * pipeline that must never reach either can still share this framing.
 */
import { HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import type { AiUnavailableReason } from "@/lib/ai/capabilities/types";
import type { CoachStreamEvent } from "@/lib/ai/coach/types";
import { appendMessage, createConversation } from "@/lib/ai/coach/persistence";
import { createSseStream, type SseController } from "@/lib/sse/create-stream";

import type { ReplyOutcome, TurnEmitter } from "./types";

export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function encodeFrame(event: CoachStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * v1.22 (#89) — keepalive heartbeat. An SSE COMMENT frame (a line starting
 * with `:`) carries no `data:` payload, so the Coach client's frame parser
 * (`parseSseChunk` finds the `data:` line; a comment frame has none) drops it
 * silently — exactly what a keepalive should be. Flushed on `HEARTBEAT_MS`
 * while the provider is still loading the model / generating, so a reverse
 * proxy never idle-drops the long-lived SSE connection.
 */
const HEARTBEAT_MS = 12_000;
const HEARTBEAT_FRAME = new TextEncoder().encode(": ka\n\n");

/**
 * Keepalive: an SSE comment frame (`: ka`) the client parser ignores,
 * flushed on an interval through the pre-first-token (prompt-processing)
 * and generation phases. Returns the stop function.
 */
export function startHeartbeat(controller: SseController): () => void {
  const heartbeat = setInterval(() => {
    controller.enqueue(HEARTBEAT_FRAME);
  }, HEARTBEAT_MS);
  return () => clearInterval(heartbeat);
}

/** The frame channel of one turn, over one stream controller. */
export function createTurnEmitter(controller: SseController): TurnEmitter {
  return {
    emit: (frame) => controller.enqueue(encodeFrame(frame)),
    aborted: () => controller.signal.aborted,
  };
}

/**
 * Split a full assistant reply into ~roughly-word-sized chunks so the
 * UI gets a "streaming" feel even when the underlying provider client
 * returned the body in one shot.
 */
function tokeniseForStreaming(content: string): string[] {
  if (!content) return [];
  // Split on whitespace boundaries while preserving the spaces — keeps
  // word boundaries intact and avoids the UI having to glue tokens.
  const matches = content.match(/\S+\s*/g);
  return matches ?? [content];
}

/**
 * v1.12.0 — yield control back to the event loop for one tick so the
 * stream controller flushes the just-enqueued frame before the next one
 * is produced. `setTimeout(0)` (rather than a bare `Promise.resolve()`
 * microtask) hands the turn back to the platform's stream pump so each
 * SSE frame lands in its own network chunk; a microtask would drain
 * before the runtime gets a chance to flush. The delay is intentionally
 * zero — we want incremental delivery, not an artificial typewriter
 * pause.
 */
function flushTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Emit a finished turn. A failed outcome is one `error` frame. A guarded
 * reply goes out as `token* → provenance → result* → suggestion? →
 * suggestedAction? → memoryNote? → planProposal? → clarification? →
 * followUps? → done`; the token frames carry the FULLY-GUARDED text, and
 * every guard ran before the first one leaves. The live `step` and
 * `activity` frames went out earlier, while the model ran; the last of them
 * opens the `answer` entry, which `done` closes.
 */
export async function emitReply(
  emitter: TurnEmitter,
  outcome: ReplyOutcome,
  conversationId: string,
): Promise<void> {
  if (!outcome.ok) {
    if (!emitter.aborted()) {
      emitter.emit({
        type: "error",
        code: outcome.code,
        message: outcome.code,
      });
    }
    return;
  }

  for (const tok of tokeniseForStreaming(outcome.replyText)) {
    // v1.18.10 (A-2) — stop tokenising the moment the client disconnects.
    if (emitter.aborted()) return;
    emitter.emit({ type: "token", token: tok });
    await flushTick();
  }
  if (emitter.aborted()) return;
  emitter.emit({ type: "provenance", metricSource: outcome.provenance });
  // v1.39.4 — additive `result` frames: the tables this turn read, after
  // every guard and only on the owner's own stream.
  for (const result of outcome.results) {
    emitter.emit({ type: "result", result });
  }
  // v1.18.1 (Workstream C) — additive `suggestion` frame.
  if (outcome.suggestion) {
    emitter.emit({ type: "suggestion", suggestion: outcome.suggestion });
  }
  // v1.22 (F6) — additive `suggestedAction` frame.
  if (outcome.action) {
    emitter.emit({
      type: "suggestedAction",
      suggestedAction: outcome.action,
    });
  }
  // v1.41 — additive `memoryNote` and `planProposal` frames, owner only.
  if (outcome.memoryNote) {
    emitter.emit({ type: "memoryNote", note: outcome.memoryNote });
  }
  if (outcome.planProposal) {
    emitter.emit({ type: "planProposal", proposal: outcome.planProposal });
  }
  // v1.39.4 — additive `clarification` and `followUps` frames.
  if (outcome.clarification) {
    emitter.emit({
      type: "clarification",
      clarification: outcome.clarification,
    });
  }
  if (outcome.followUps.length > 0) {
    emitter.emit({ type: "followUps", followUps: outcome.followUps });
  }
  // v1.18.9 — additive `usage` envelope on the `done` frame.
  emitter.emit({
    type: "done",
    conversationId,
    messageId: outcome.messageId,
    usage: {
      totalTokens: outcome.totalTokens || null,
      model: outcome.model,
    },
    // v1.41 — why the answer was forced, and whether the interim tables
    // must come down again.
    ...(outcome.stop ? { stop: outcome.stop } : {}),
    ...(outcome.withheldResults ? { withheldResults: true as const } : {}),
  });
}

/**
 * Emit a refusal as a single `token` frame followed by `done`. No
 * provider call, no persisted assistant message — the user message is
 * still kept on disk so the rail shows the conversation history
 * accurately. The user message landing on disk is a deliberate choice;
 * the rail otherwise wouldn't show the user's attempt at all.
 */
export async function streamRefusal(args: {
  userId: string;
  conversationId: string | undefined;
  message: string;
  refusalText: string;
}): Promise<Response> {
  let conversationId = args.conversationId;
  if (!conversationId) {
    const created = await createConversation({
      userId: args.userId,
      title: args.message,
    });
    conversationId = created.id;
  } else {
    const owned = await prisma.coachConversation.findFirst({
      where: { id: conversationId, userId: args.userId },
      select: { id: true },
    });
    if (!owned) {
      throw new HttpError(404, "coach.conversation.notFound");
    }
  }

  await appendMessage({
    conversationId,
    role: "user",
    content: args.message,
  });
  const refusalMessage = await appendMessage({
    conversationId,
    role: "assistant",
    content: args.refusalText,
    metricSource: { windows: [], metrics: ["general"] },
    providerType: "refusal",
    promptVersion: PROMPT_VERSION,
  });

  const stream = createSseStream((controller) => {
    controller.enqueue(encodeFrame({ type: "token", token: args.refusalText }));
    controller.enqueue(
      encodeFrame({
        type: "done",
        conversationId,
        messageId: refusalMessage.id,
      }),
    );
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export function streamProviderError(args: {
  code: string;
  /** The capability reason, when the refusal came from one. */
  reason?: AiUnavailableReason;
}): Response {
  const stream = createSseStream((controller) => {
    controller.enqueue(
      encodeFrame({
        type: "error",
        code: args.code,
        message: args.code,
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    );
  });
  // Status 200 so the streaming client reads the SSE body and parses
  // the structured `error` frame (HTTP-status branches drop the
  // structured code on the floor).
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
