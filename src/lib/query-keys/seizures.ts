/**
 * Query keys — the seizure diary (#1368).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * One read feeds the page (`GET /api/seizures`: types, rule, the period's
 * seizures and the summary), so one root covers it; the period is part of the
 * key, because the default 90 days and a year asked for the report preview are
 * two different answers.
 */
export const seizureKeys = {
  /** The root every seizure write invalidates. */
  seizures: () => ["seizures"] as const,
  /** The diary over one period (`from`/`to` ISO, or `default`). */
  seizureDiary: (period: string) => ["seizures", "diary", period] as const,
  seizureEventCreate: () => ["seizures", "event", "create"] as const,
  seizureEventUpdate: () => ["seizures", "event", "update"] as const,
  seizureEventDelete: () => ["seizures", "event", "delete"] as const,
  seizureRescueCreate: () => ["seizures", "rescue", "create"] as const,
  seizureRescueUpdate: () => ["seizures", "rescue", "update"] as const,
  seizureRescueDelete: () => ["seizures", "rescue", "delete"] as const,
  seizureTypeCreate: () => ["seizures", "type", "create"] as const,
  seizureTypeUpdate: () => ["seizures", "type", "update"] as const,
  seizureTypeDelete: () => ["seizures", "type", "delete"] as const,
  seizureSettingsUpdate: () => ["seizures", "settings", "update"] as const,
};
