/**
 * Insight memory — what the AI told this user last time.
 *
 * Every status generator (general / blood-pressure / weight / pulse /
 * bmi / medication-compliance / mood) caches its rendered text in an
 * `audit_logs` row keyed by `action = "insights.{scope}.{locale}"`.
 * v1.4 turns that history into prompt context: the next generation
 * sees the previous classification + a short summary, so the model
 * can call out improvements and regressions instead of restating
 * status from scratch every day.
 *
 * Two consumers share this helper:
 *
 * - The status-generator pipeline reads the previous snapshot via
 *   `getPreviousInsightContext()` and injects it into the user prompt.
 * - The card UI reads the `delta` flag derived in
 *   `compareSnapshots()` and renders ↑/↓/→ glyphs next to findings.
 */

import { prisma } from "@/lib/db";

/**
 * Stable identifiers for the seven insight scopes. The string MUST
 * match the suffix in the existing audit-log `action` field so we
 * read the same rows the cache already writes.
 */
export type InsightScope =
  | "general-status"
  | "blood-pressure-status"
  | "weight-status"
  | "pulse-status"
  | "bmi-status"
  | "medication-compliance-status"
  | "mood-status";

export interface PreviousInsightContext {
  /** ISO timestamp the previous analysis was rendered. */
  generatedAt: string;
  /** Days between the previous analysis and now (rounded down). */
  ageDays: number;
  /**
   * Free-text snapshot of the previous analysis — typically the
   * `summary` field from `InsightResult` or the rendered narrative.
   * Already in the user's locale.
   */
  text: string;
}

/**
 * Read the most recent cached insight for `userId` + `scope` + `locale`
 * that is at least `minAgeHours` old. Returns null when no eligible
 * snapshot exists (first-run users) or when the cache row's payload
 * is malformed.
 *
 * The default 12-hour floor keeps the model from comparing today's
 * 09:00 reading to today's 06:00 reading and treating sub-day noise as
 * a real change. Status generators pass shorter floors when force-
 * regenerating.
 */
export async function getPreviousInsightContext(
  userId: string,
  scope: InsightScope,
  locale: "de" | "en",
  minAgeHours: number = 12,
): Promise<PreviousInsightContext | null> {
  const action = `insights.${scope}.${locale}`;
  const olderThan = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

  const row = await prisma.auditLog.findFirst({
    where: {
      userId,
      action,
      createdAt: { lt: olderThan },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });

  if (!row?.details) return null;

  let text: string | null = null;
  try {
    const parsed = JSON.parse(row.details) as {
      text?: unknown;
      summary?: unknown;
    };
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
      text = parsed.text;
    } else if (
      typeof parsed.summary === "string" &&
      parsed.summary.trim().length > 0
    ) {
      text = parsed.summary;
    }
  } catch {
    // Older cache rows stored raw text instead of JSON. Surface them
    // verbatim so the prompt still benefits from the comparison.
    if (row.details.trim().length > 0) {
      text = row.details;
    }
  }

  if (!text) return null;

  const ageMs = Date.now() - row.createdAt.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));

  return {
    generatedAt: row.createdAt.toISOString(),
    ageDays,
    // Cap text so a verbose previous analysis cannot bloat the prompt.
    text: text.length > 1500 ? text.slice(0, 1500) + "…" : text,
  };
}

/**
 * Format a previous-context block for direct injection into the user
 * prompt. Output already locale-aware.
 *
 * Example (de):
 *   "VORHERIGE ANALYSE (vor 7 Tagen, 2026-05-01):
 *    Dein Blutdruck war im Schnitt 132/85 — grenzwertig. …"
 */
export function formatPreviousContextForPrompt(
  ctx: PreviousInsightContext | null,
  locale: "de" | "en",
): string {
  if (!ctx) {
    return locale === "en"
      ? "PREVIOUS ANALYSIS: none on file. Treat this as the user's first analysis for this domain — no improvement/regression delta to surface."
      : "VORHERIGE ANALYSE: keine vorhanden. Behandle dies als erste Analyse in diesem Bereich — kein Verbesserungs-/Verschlechterungs-Delta zu nennen.";
  }

  const dateLabel = ctx.generatedAt.slice(0, 10);
  if (locale === "en") {
    const ageLabel =
      ctx.ageDays === 0
        ? "earlier today"
        : ctx.ageDays === 1
          ? "1 day ago"
          : `${ctx.ageDays} days ago`;
    return [
      `PREVIOUS ANALYSIS (${ageLabel}, ${dateLabel}):`,
      ctx.text,
      "",
      'INSTRUCTION: When summarising the current state, explicitly call out what improved, what regressed, and what stayed the same compared to that previous snapshot. Use phrases like "down 4 mmHg from your last check" or "same elevated trend as last week". Do not invent numbers — only compare what\'s in the snapshot below.',
    ].join("\n");
  }

  const ageLabel =
    ctx.ageDays === 0
      ? "heute früher"
      : ctx.ageDays === 1
        ? "vor 1 Tag"
        : `vor ${ctx.ageDays} Tagen`;
  return [
    `VORHERIGE ANALYSE (${ageLabel}, ${dateLabel}):`,
    ctx.text,
    "",
    'ANWEISUNG: Wenn du den aktuellen Stand zusammenfasst, benenne explizit was sich verbessert hat, was schlechter geworden ist und was gleich geblieben ist gegenüber dieser vorherigen Analyse. Verwende Formulierungen wie "4 mmHg niedriger als beim letzten Check" oder "gleicher erhöhter Trend wie letzte Woche". Erfinde keine Zahlen — vergleiche nur das, was im Snapshot unten steht.',
  ].join("\n");
}
