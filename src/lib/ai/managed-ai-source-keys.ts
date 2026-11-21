/**
 * #1403 — the closed set of provider sources a managed profile may use, kept
 * apart from the resolver so the settings schema (which client code imports)
 * pulls no database code with it. Mirrors the `ManagedAiSource` enum.
 */
export const MANAGED_AI_SOURCES = ["INSTANCE", "NONE", "GUARDIAN"] as const;
export type ManagedAiSourceKey = (typeof MANAGED_AI_SOURCES)[number];
