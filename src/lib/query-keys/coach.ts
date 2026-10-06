/**
 * Query keys — Coach preferences, facts, about-me, and nudge state.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const coachKeys = {
  coachPrefs: () => ["coach-prefs"] as const,
  coachFacts: () => ["coach-facts"] as const,
  /** v1.15.20 — Settings → AI "about me" self-description. */
  coachAboutMe: () => ["coach-about-me"] as const,
  /** v1.16.0 — pending clarifying questions (Coach composer chips). */
  coachAboutMeQuestions: () => ["coach-about-me", "questions"] as const,
  /** Encrypted, effective-dated structured anamnesis facts. */
  healthProfileFacts: () => ["health-profile-facts"] as const,
  /** v1.16.1 — unseen proactive-nudge state for the floating Coach bubble. */
  coachNudgeStatus: () => ["coach-nudge-status"] as const,
  /** v1.18.6 (CCH-03) — mark-Coach-seen mutation (clears the FAB unread dot). */
  coachMarkSeen: () => ["coach-mark-seen"] as const,
  /**
   * v1.18.7 — the Coach conversation rail list (`GET /api/insights/chat`).
   * Previously a hook-local bare `["coachConversations"]`; centralised so
   * the optimistic delete and the streaming hook's post-turn invalidation
   * share one factory-routed key.
   */
  coachConversations: () => ["coachConversations"] as const,
  /**
   * v1.30.2 — the full, paginated + searchable rail history
   * (`useInfiniteQuery` over `GET /api/insights/chat?cursor&q`). Nested under
   * the `coachConversations` prefix (not a sibling key) so the existing
   * delete-mutation + post-turn invalidation (`coachConversations()`) still
   * reaches every cached search variant of this infinite list — TanStack's
   * default `invalidateQueries` match is prefix-based, so no extra
   * invalidation call site was needed. `search` is the trimmed query text;
   * empty string keys the unfiltered ("browse everything") variant.
   */
  coachConversationHistory: (search = "") =>
    ["coachConversations", "history", search.trim()] as const,
  /**
   * v1.18.7 — one decrypted Coach conversation (`GET /api/insights/chat/[id]`).
   * Keyed on the conversation id so two open threads never share a cache slot;
   * the streaming hook invalidates this slot once the persisted twin lands.
   */
  coachConversation: (id: string | null) => ["coachConversation", id] as const,
  /**
   * v1.29.x (S7) — mutationKey for the attach/detach document mutations on a
   * fenced conversation (`POST`/`DELETE /api/insights/chat/{id}/attachments`).
   * Nested under the conversation key so the mutation and the detail read stay
   * co-located in the factory.
   */
  coachAttachmentMutation: (conversationId: string) =>
    ["coachConversation", conversationId, "attachments"] as const,
  /**
   * v1.39.4 — the stored tables of one assistant message
   * (`GET /api/insights/chat/{id}/messages/{messageId}/results`). Nested under
   * the conversation key so deleting or invalidating the conversation reaches
   * every message's tables with the existing prefix match.
   */
  coachMessageResults: (conversationId: string, messageId: string) =>
    [
      "coachConversation",
      conversationId,
      "messages",
      messageId,
      "results",
    ] as const,
  /**
   * v1.41 — the owner-only model text of one assistant message's trail
   * (`GET /api/insights/chat/{id}/messages/{messageId}/trail`), read when
   * the person opens the trail. Nested under the conversation key like the
   * tables.
   */
  coachMessageTrail: (conversationId: string, messageId: string) =>
    [
      "coachConversation",
      conversationId,
      "messages",
      messageId,
      "trail",
    ] as const,
  /**
   * v1.21.2 (A3) — today's most notable derived signal, resolved into the
   * Coach hero's pre-seeded relevance opener
   * (`GET /api/insights/coach/seeded-question`).
   */
  coachSeededQuestion: () => ["coach-seeded-question"] as const,
  /**
   * v1.22 (B2/B6) — the user's Coach episodic reminders (`GET /api/coach/
   * reminders`). The optional `status` arg keys the in-app tile read
   * (`due,surfaced`) separately from the full ledger list so the two never
   * share a cache slot.
   */
  coachReminders: (status?: string) =>
    ["coach-reminders", status ?? "all"] as const,
  /** Prefix key — invalidates every `coachReminders(status)` slot at once. */
  coachRemindersAll: () => ["coach-reminders"] as const,
  /**
   * v1.27.x — the user's Coach goal / if-then plans (`GET /api/coach/plans`).
   * The `filter` arg keys the chat thread's proposal read (`status:proposed`)
   * separately from the management page's ledger read (`scope:all`) so the
   * two never share a cache slot.
   */
  coachPlans: (filter?: string) =>
    ["coach-plans", filter ?? "default"] as const,
  /** Prefix key — invalidates every `coachPlans(filter)` slot at once. */
  coachPlansAll: () => ["coach-plans"] as const,
};
