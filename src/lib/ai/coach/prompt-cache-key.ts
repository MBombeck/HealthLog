/**
 * v1.41.2 — the prompt-cache key of a Coach conversation.
 *
 * Every round of a turn resends the same system prompt and history, and the
 * next turn of the conversation resends it again with one more exchange. A
 * provider that routes requests to its prompt cache by key (Codex,
 * `api.openai.com`) only finds the prefix an earlier call left there when the
 * calls carry the same key. One key per conversation does that; a turn with
 * no conversation yet gets a key of its own, still shared by its rounds.
 *
 * Hashed so the provider never sees the conversation id itself.
 */
import { createHash, randomUUID } from "node:crypto";

export function coachPromptCacheKey(conversationId?: string | null): string {
  return createHash("sha256")
    .update(`coach-prompt:${conversationId || randomUUID()}`)
    .digest("hex")
    .slice(0, 32);
}
