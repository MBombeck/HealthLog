/**
 * Query keys — admin surfaces (users, tokens, logs, backups, feedback,
 * audit log, host metrics, invites).
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const adminKeys = {
  /**
   * v1.4.41 — admin surfaces. Pre-fix every admin section declared its
   * own bare-literal `["admin", "<name>"]`. Routing through the factory
   * lets a single rename change every consumer in lockstep.
   */
  adminAiQuality: () => ["admin", "ai-quality"] as const,
  /**
   * v1.16.6 — operator-wide AI key (the `admin-openai` chain fallback).
   * Read/write via `/api/admin/ai-settings`; the user-facing
   * `insightsSettings.hasAdminKey` flag mirrors the configured state.
   */
  adminAiServerKey: () => ["admin", "ai-server-key"] as const,
  /**
   * v1.37.31 — per-provider delivery health folded from the per-user
   * retry ledger. Read via `/api/admin/provider-health`.
   */
  adminProviderHealth: () => ["admin", "provider-health"] as const,
  /**
   * Operator-shared central Codex (ChatGPT subscription) connection status.
   * Read/write via `/api/admin/central-codex`; the user-facing
   * `insightsSettings.centralCodexAvailable` flag mirrors the connected state.
   */
  adminCentralCodex: () => ["admin", "central-codex"] as const,
  adminAppLogs: (
    traceId: string | undefined,
    action: string | undefined,
    level: string | undefined,
    range: string | undefined,
  ) => ["admin", "app-logs", traceId, action, level, range] as const,
  adminAssistantFlags: () => ["admin", "settings", "assistant-flags"] as const,
  /** v1.18.0 — operator-level server-wide module availability matrix. */
  adminModuleAvailability: () =>
    ["admin", "settings", "module-availability"] as const,
  adminBackups: () => ["admin", "backups"] as const,
  /** v1.37.20 — restore preview: the counts a stored backup file carries. */
  adminBackupSummary: (id: string) =>
    ["admin", "backups", id, "summary"] as const,
  /**
   * v1.39.1 — the restore jobs the backups console shows. Its own prefix, so
   * invalidating the backup list does not refetch the poll and vice versa.
   */
  adminBackupRestores: () => ["admin", "backup-restores"] as const,
  /** v1.23 — encryption coverage + rotation progress (admin Encryption section). */
  adminEncryptionStatus: () => ["admin", "encryption", "status"] as const,
  adminCoachFeedback: () => ["admin", "coach-feedback"] as const,
  adminFeedback: (status: string) => ["admin", "feedback", status] as const,
  adminFeedbackRoot: () => ["admin", "feedback"] as const,
  adminHostMetrics: (window: string) =>
    ["admin", "host-metrics", window] as const,
  /** v1.15.20 — registration invite list (admin Users section). */
  adminInvites: () => ["admin", "invites"] as const,
  adminAuditActions: () => ["admin", "audit-log", "actions"] as const,
  adminAuditOverview: () => ["admin", "audit-log", "overview-preview"] as const,
  /**
   * v1.4.42 W3-QUERYKEY-LONGTAIL — paginated + filtered audit-log
   * read used by the login-overview admin section. The `filtered`
   * discriminator at index 2 keeps the no-arg `adminAuditLog(filter)`
   * cache slot byte-distinct so its consumers don't collide.
   */
  adminAuditLogFiltered: (params: {
    filter: string;
    page: number;
    perPage: number;
    actor: string;
    actionFilter: string;
    target: string;
    range: string;
  }) =>
    [
      "admin",
      "audit-log",
      "filtered",
      params.filter,
      params.page,
      params.perPage,
      params.actor,
      params.actionFilter,
      params.target,
      params.range,
    ] as const,

  adminSettings: () => ["admin", "settings"] as const,
  adminStatus: () => ["admin", "status"] as const,
  /** v1.17.1 — operator-wide notification delivery-health panel. */
  adminNotificationHealth: (hours: number) =>
    ["admin", "notification-health", hours] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminTokens: () => ["admin", "tokens"] as const,
  adminAuditLog: (filter: unknown) => ["admin", "audit-log", filter] as const,
};
