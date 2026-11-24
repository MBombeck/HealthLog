/**
 * Lab values staged from a stored document's text without a model.
 *
 * The document's text is what the vault holds for it already (its content
 * index: the PDF text layer, OCR on this server, or a provider's
 * transcription). `readLabValues` reads the table rows out of it by rule,
 * and the rows are staged in the same shape the AI extraction stages them
 * (`InboundExtractionResult`, OBSERVATION facts with anchored provenance),
 * PENDING for the same review screen, confirmed through the same commit. One
 * pipeline after the read, whichever read it was.
 *
 * Model work is gated by an AI capability; data is not. Nothing here asks
 * for one: with AI switched off, with "local only", or with no provider at
 * all, a lab report is still read into values for the person to check. Two
 * callers: the document index job, when the AI staging did not stage
 * (`maybeStageLabValuesWithoutModel`), and the person's own request
 * (`POST /api/documents/inbound/{id}/lab-values`).
 */
import { anchorSourceText } from "@/lib/documents/anchor-source-text";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { looksLikeLabDocument } from "@/lib/documents/auto-stage-labs";
import { LOCAL_PARSER_PROVIDER } from "@/lib/documents/inbound-constants";
import type {
  InboundExtractionResult,
  StagedFactInput,
} from "@/lib/documents/extract";
import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { isDimensionlessUnit } from "@/lib/labs/dimensionless";
import { readLabValues } from "@/lib/labs/lab-text-parser";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import {
  INBOUND_CONFIDENCE_FLOOR,
  INBOUND_MAX_FACTS,
  type ObservationFactData,
} from "@/lib/validations/inbound-documents";

/**
 * The staged facts for a document's text. `ocr` when the text came from OCR,
 * whose unit misreadings the reader repairs and whose rows it trusts less.
 */
export function labValuesFromText(
  text: string,
  options: { ocr: boolean },
): InboundExtractionResult {
  const reading = readLabValues(text, {
    ocr: options.ocr,
    // One more than the review takes, so a longer report says it is longer.
    maxRows: INBOUND_MAX_FACTS + 1,
  });
  const rows = reading.rows.slice(0, INBOUND_MAX_FACTS);
  const facts: StagedFactInput[] = rows.map((row) => {
    const data: ObservationFactData = {
      label: row.label,
      code: null,
      codeSystem: null,
      value: row.value,
      valueText: row.value === null ? row.valueText : null,
      unit: row.unit,
      referenceLow: row.referenceLow,
      referenceHigh: row.referenceHigh,
      referenceText: row.referenceText,
      effectiveDate: null,
    };
    // The line is looked up in the text it came from, as a model's quote is,
    // so the stored span is the document's own characters.
    const anchor = anchorSourceText(row.line, text);
    return {
      factType: "OBSERVATION",
      confidence: row.confidence,
      needsReview:
        row.confidence < INBOUND_CONFIDENCE_FLOOR ||
        row.doubts.length > 0 ||
        !anchor.anchored ||
        isDimensionlessUnit(row.unit),
      data,
      provenance: {
        sourceText: anchor.sourceText,
        anchored: anchor.anchored,
        sourceOffset: anchor.sourceOffset,
        page: null,
        confidence: row.confidence,
      },
    };
  });
  return {
    reportDate: reading.reportDate,
    kind: "OTHER",
    providerType: LOCAL_PARSER_PROVIDER,
    facts,
    incomplete: reading.rows.length > INBOUND_MAX_FACTS,
  };
}

/** The document's stored text and whether OCR produced it, or null. */
export async function storedTextForLabValues(
  userId: string,
  documentId: string,
): Promise<{ text: string; ocr: boolean } | null> {
  const [chat, index] = await Promise.all([
    loadDocumentChatText(userId, documentId),
    prisma.documentContentIndex.findFirst({
      where: { documentId, userId },
      select: { source: true },
    }),
  ]);
  if (!chat || !chat.text.trim()) return null;
  return {
    text: chat.text,
    ocr: index?.source === "local-ocr" || index?.source === "text-ocr",
  };
}

export type LocalStageOutcome =
  | { staged: true; facts: number }
  | {
      staged: false;
      reason:
        | "modules-off"
        | "already-handled"
        | "deferred"
        | "no-text"
        | "not-lab"
        | "no-values"
        | "raced";
    };

/**
 * Stage the lab values of a freshly indexed document by rule, for the
 * review. The same guards as the AI staging, minus the provider: both
 * modules on, the document still STORED with nothing staged, not an import
 * held back from reading, and a text that reads like a lab report (or a
 * document filed as one). The `STORED → EXTRACTED` move is guarded, so a
 * read that got there first wins and this one stages nothing.
 */
export async function maybeStageLabValuesWithoutModel(
  userId: string,
  documentId: string,
): Promise<LocalStageOutcome> {
  const [inboundOn, labsOn] = await Promise.all([
    isModuleEnabled(userId, "inboundDocuments"),
    isModuleEnabled(userId, "labs"),
  ]);
  if (!inboundOn || !labsOn) return { staged: false, reason: "modules-off" };

  const doc = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: {
      kind: true,
      status: true,
      aiReadDeferred: true,
      _count: { select: { facts: true } },
    },
  });
  if (!doc || doc.status !== "STORED" || doc._count.facts > 0) {
    return { staged: false, reason: "already-handled" };
  }
  // A held-back import waits for the person, whatever reads it.
  if (doc.aiReadDeferred) return { staged: false, reason: "deferred" };

  const stored = await storedTextForLabValues(userId, documentId);
  if (!stored) return { staged: false, reason: "no-text" };
  if (doc.kind !== "LAB_RESULT" && !looksLikeLabDocument(stored.text)) {
    return { staged: false, reason: "not-lab" };
  }

  const result = labValuesFromText(stored.text, { ocr: stored.ocr });
  // Nothing read is nothing staged: the document stays STORED, so a later
  // read (the person's, with or without AI) still finds it untouched.
  if (result.facts.length === 0) {
    annotate({
      action: { name: "documents.labValues.none" },
      meta: { documentId, ocr: stored.ocr },
    });
    return { staged: false, reason: "no-values" };
  }

  const staged = await prisma.$transaction(async (tx) => {
    const moved = await tx.inboundDocument.updateMany({
      where: { id: documentId, userId, status: "STORED", deletedAt: null },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        extractionIncomplete: result.incomplete,
        reportDate: result.reportDate
          ? dateOnlyAtNoonUtc(result.reportDate)
          : null,
      },
    });
    if (moved.count === 0) return null;
    await tx.extractedFact.createMany({
      data: result.facts.map((f) => ({
        documentId,
        userId,
        factType: f.factType,
        status: "PENDING" as const,
        confidence: f.confidence,
        needsReview: f.needsReview,
        dataEncrypted: encryptFactData(f.data),
        provenanceEncrypted: encryptFactProvenance(f.provenance),
      })),
    });
    return result.facts.length;
  });
  if (staged === null) return { staged: false, reason: "raced" };

  annotate({
    action: { name: "documents.labValues.staged" },
    meta: {
      documentId,
      facts: staged,
      needsReview: result.facts.filter((f) => f.needsReview).length,
      ocr: stored.ocr,
      byKind: doc.kind === "LAB_RESULT",
      incomplete: result.incomplete,
      trigger: "index",
    },
  });
  return { staged: true, facts: staged };
}
