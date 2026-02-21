/**
 * Global pg-boss instance accessor.
 * Uses globalThis to share the instance across Turbopack chunks.
 * Set by the reminder worker on startup, read by notification senders
 * for scheduling delayed cleanup jobs.
 */
import type { PgBoss } from "pg-boss";

const BOSS_KEY = "__healthlog_pgboss__" as const;

export function setGlobalBoss(boss: PgBoss) {
  (globalThis as Record<string, unknown>)[BOSS_KEY] = boss;
}

export function getGlobalBoss(): PgBoss | null {
  return ((globalThis as Record<string, unknown>)[BOSS_KEY] as PgBoss) ?? null;
}
