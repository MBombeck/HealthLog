/**
 * `GET /api/mental-health/assessments/[id]` — one screener administration WITH
 * its decrypted per-item answers.
 *
 * The list route beside this one denormalises total + band + item-9 flag for
 * cheap history reads and deliberately never touches `responsesEncrypted`.
 * Until this route existed nothing read the blob back at all (its only
 * consumer was key rotation), so the stored clinical detail — including the
 * PHQ-9 item-9 answer — was invisible to the person it belongs to. This is
 * the read side of that write.
 *
 * GATING — same declaration as the sibling list read (`read`, `mind`), on
 * purpose: the mind domain already serves decrypted free text at this level
 * (the mood entry's encrypted note on `GET /api/mood-entries/[id]`, the Coach
 * reminder notes), and the list read already publishes `item9Flagged` — the
 * fact that the self-harm item was answered non-zero. A delegate the owner
 * trusted with a mind-scope read grant therefore learns nothing here that is
 * categorically beyond what the domain already shows; splitting the per-item
 * values onto a stricter gate than the mood diary's prose would be an
 * inconsistency, not a protection. The module gate resolves against the
 * RECORD, so the surface stays unreachable wherever the owner keeps the
 * module off.
 *
 * DECRYPT FAILURES degrade honestly (the records-DTO fail-soft precedent):
 * `items: null` + `itemsUnavailable: true`, with the denormalised score
 * fields still answering — a key gap on one row never 500s the read. A
 * plaintext whose item count no longer matches the instrument degrades the
 * same way, because pairing answers to the wrong official item texts would be
 * worse than showing none.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { SCREENER_INSTRUMENTS } from "@/lib/validations/mental-health";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate, getEvent } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  INSTRUMENTS,
  type InstrumentDefinition,
  type InstrumentId,
} from "@/lib/mental-health/instruments";

type RouteParams = { params: Promise<{ id: string }> };

interface DecodedResponses {
  /** Per-item answers in presentation order, or null when unreadable. */
  items: number[] | null;
  /** The unscored PHQ-9 functional follow-up, when it was answered. */
  functionalDifficulty: number | null;
  itemsUnavailable: boolean;
}

const UNAVAILABLE: DecodedResponses = {
  items: null,
  functionalDifficulty: null,
  itemsUnavailable: true,
};

/**
 * Decrypt + decode the stored `{ items, functionalDifficulty?, schema: 1 }`
 * blob, fail-soft. Every answer is re-checked against the instrument's own
 * ceiling before it is served: the write path validated exactly these bounds,
 * so anything outside them is corruption, not data.
 */
function decodeResponses(
  buf: Uint8Array,
  def: InstrumentDefinition,
): DecodedResponses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptFromBytes(buf));
  } catch (err) {
    // Undecryptable payload (key gap / corruption): fail soft but log it
    // (F-CRYPTO-2) so a systemic key gap surfaces instead of reading blank.
    getEvent()?.addWarning(
      `assessment responses decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNAVAILABLE;
  }
  if (typeof parsed !== "object" || parsed === null) return UNAVAILABLE;
  const { items, functionalDifficulty } = parsed as {
    items?: unknown;
    functionalDifficulty?: unknown;
  };
  const valid =
    Array.isArray(items) &&
    items.length === def.itemCount &&
    items.every(
      (v) => Number.isInteger(v) && (v as number) >= 0 && v <= def.itemMax,
    );
  if (!valid) {
    getEvent()?.addWarning(
      "assessment responses shape drifted from the instrument definition",
    );
    return UNAVAILABLE;
  }
  return {
    items: items as number[],
    functionalDifficulty:
      Number.isInteger(functionalDifficulty) &&
      (functionalDifficulty as number) >= 0 &&
      (functionalDifficulty as number) <= 3
        ? (functionalDifficulty as number)
        : null,
    itemsUnavailable: false,
  };
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "mind");

    // Opt-in module (default OFF) — the same record-resolved gate as the list.
    const gate = await requireModuleEnabled(user.id, "mentalHealth");
    if (!gate.enabled) return gate.response;

    const { id } = await params;

    // Fetch-then-guard against the resolved user (the by-id sibling pattern);
    // a soft-deleted row 404s like it does on the list.
    const row = await prisma.mentalHealthAssessment.findFirst({
      // Screeners only; an AUDIT-C entry (v1.43) is a 404 here.
      where: {
        id,
        deletedAt: null,
        instrument: { in: [...SCREENER_INSTRUMENTS] },
      },
      select: {
        id: true,
        userId: true,
        instrument: true,
        locale: true,
        wording: true,
        version: true,
        totalScore: true,
        severityBand: true,
        item9Flagged: true,
        crisisShownAt: true,
        takenAt: true,
        createdAt: true,
        responsesEncrypted: true,
      },
    });
    if (!row || row.userId !== user.id) {
      return apiError("Assessment not found", 404);
    }

    const def = INSTRUMENTS[row.instrument as InstrumentId];
    const decoded = decodeResponses(row.responsesEncrypted, def);

    annotate({
      action: { name: "mental-health.detail" },
      // The instrument + degrade flag only — item answers are NEVER logged.
      meta: {
        instrument: row.instrument,
        items_unavailable: decoded.itemsUnavailable,
      },
    });

    return apiSuccess({
      assessment: {
        id: row.id,
        instrument: row.instrument,
        locale: row.locale,
        wording: row.wording,
        version: row.version,
        totalScore: row.totalScore,
        severityBand: row.severityBand,
        item9Flagged: row.item9Flagged,
        crisisShownAt: row.crisisShownAt?.toISOString() ?? null,
        takenAt: row.takenAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        items: decoded.items,
        functionalDifficulty: decoded.functionalDifficulty,
        itemsUnavailable: decoded.itemsUnavailable,
      },
    });
  },
);
