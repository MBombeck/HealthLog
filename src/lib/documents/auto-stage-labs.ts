/**
 * S8 — auto-stage lab facts from a freshly indexed vault document.
 *
 * After the per-document auto-index job transcribes a stored document, a
 * document that LOOKS LIKE a lab result is run through the SAME inbound
 * extraction the manual "Extract" button uses — but the facts land PENDING for
 * the existing human-review screen. Nothing is committed here: the user still
 * taps one confirm before a value becomes a `LabResult`. Marc's sign-off is
 * explicit — auto-STAGE, never auto-COMMIT.
 *
 * Gates (ALL must hold, otherwise the manual extract button is left untouched):
 *   - both the `inboundDocuments` AND `labs` modules are on for the user;
 *   - a usable document-order provider whose egress the `documentsAutoAiRead`
 *     consent gate permits — reuses `resolveIndexProvider`, so a local pick is
 *     always eligible and an external pick needs the opt-in, IDENTICAL to the
 *     auto-index external-egress gate;
 *   - the document is still STORED with no staged facts — so a re-index, the
 *     manual path, or the labs→vault cross-link (S9) never double-stages;
 *   - the transcribed text reads like a lab report (a cheap keyword heuristic,
 *     or the user filed it under kind LAB_RESULT), so an arbitrary photo never
 *     burns an extraction call.
 *
 * It reuses the transcription the auto-index already produced (the encrypted
 * content index) and runs the extraction in TEXT mode, so no second vision call
 * is spent. The staging transition is a guarded `STORED → EXTRACTED` update:
 * if the labs-filing cross-link (S9) or the manual path moved the document
 * first, the guard matches zero rows and the auto-stage aborts without touching
 * any fact — the two writers can never corrupt each other's facts.
 */
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveDailyCapFor,
} from "@/lib/ai/coach/budget";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { resolveIndexProvider } from "@/lib/documents/index-document";
import {
  InboundExtractError,
  runInboundExtraction,
  type InboundExtractionResult,
} from "@/lib/documents/extract";
import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { prisma } from "@/lib/db";
import { stripDiacritics } from "@/lib/i18n/fold-for-match";
import { localisedValues } from "@/lib/i18n/shared-resolve";
import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";

/**
 * Lab-report signals used to decide whether a transcribed document is worth an
 * extraction call. Each entry is one CLASS of evidence — a reference-range
 * label, a lab unit, a common analyte name, a report header — and contributes
 * at most one hit however many of its alternatives fire. Requiring TWO
 * distinct classes keeps a stray "mg" in a prose letter from tripping the auto
 * extraction while still catching a real panel.
 *
 * Every pattern is tested against the text LOWER-CASED AND ACCENT-FOLDED, not
 * against the transcription as written, so the patterns are spelled without
 * accents. That is also what lets one pattern serve "Hämoglobin", "haemoglobin"
 * and "hemoglobin" instead of three.
 *
 * Until now the four classes were English and German only, so a French,
 * Spanish, Italian or Polish lab report scored at most one hit — the units,
 * which are the same everywhere — and auto-staging never fired for it. The
 * whole document was lost from the flow, silently: the manual extract button
 * stays available, so nothing anywhere reads as broken.
 *
 * WHICH WAY THIS ERRS. A false negative loses a real report from auto-staging;
 * a false positive burns one extraction call on a document that is not a lab
 * report, and stages facts a person then declines on the review screen —
 * nothing commits either way. The cost is lopsided, so the vocabulary is
 * widened rather than kept tight, and the two-distinct-class rule is what
 * holds the other side: an incidental "sodium" in a prose letter is one class
 * and still fails the gate. Terms whose only home is a lab report ("emocromo",
 * "bilan sanguin", "zakres referencyjny") were preferred over generic ones,
 * and short acronyms below four characters are excluded from the derived names
 * for exactly this reason — the German word "alt" would otherwise make every
 * German letter a lab report.
 */
/**
 * The analyte class, hand-written half: word stems and the short acronyms,
 * which are too short to derive safely but were vetted one at a time long ago.
 * Named rather than inlined so the derived names can be attached to THIS class
 * by identity — an index would silently re-point them at another class the
 * first time somebody reorders the list.
 */
const ANALYTE_SIGNAL =
  /h(?:a|ae|e)moglobin|glu[ck]ose|cholesterin|cholesterol|kreatinin|creatinine|hba1c|leuko|erythro|thrombo|ferritin|triglycerid|\btsh\b|\bldl\b|\bhdl\b|\bcrp\b|vitamin\s?d/i;

const LAB_SIGNALS: readonly RegExp[] = [
  // 1 — a reference-range label. Only a report that prints windows says this.
  /reference range|referenzbereich|normbereich|normal range|ref\.?-?bereich|valeurs? de reference|intervalle de reference|plage de reference|valores? de referencia|rango de referencia|intervalo de referencia|valori di riferimento|intervallo di riferimento|zakres referencyjny|wartosci referencyjne/i,
  // 2 — a lab unit. Language-independent already; unchanged.
  /\b(mg\/dl|mmol\/l|nmol\/l|µmol\/l|umol\/l|g\/dl|µg\/l|ug\/l|ng\/ml|pg\/ml|mmol\/mol|u\/l|iu\/l|mg\/l|\/µl|\/ul)\b/i,
  // 3 — an analyte name.
  ANALYTE_SIGNAL,
  // 4 — a report header.
  /labor(?:befund|wert)?|laboratory|blutbild|\bbefund\b|laboratoire|bilan sanguin|analyses medicales|hemogramme|laboratorio|analitica|hemograma|analisis de sangre|esami del sangue|emocromo|referto|laboratorium|morfologia krwi|wyniki badan/i,
];

/**
 * Class 3 again, DERIVED from `messages/<locale>.json` instead of transcribed.
 *
 * The names above are stems a maintainer typed. These are the names the app
 * itself displays for the markers in its catalog, in every language it ships —
 * so a French report's "Cholestérol total" or a Polish "Płytki krwi" counts as
 * an analyte the day the bundle carries it, with no edit here. Transcribing
 * thirty names times four more languages would have fixed today's six locales
 * and reopened the hole at the seventh.
 *
 * Names shorter than four folded characters are dropped: "ALT", "AST", "GGT",
 * "TSH" and Polish "Sód" are ordinary words or fragments in some language, and
 * a three-letter alternative in a gate this cheap is a false-positive machine.
 * The acronyms worth having are already in the hand-written class above, where
 * each was considered one at a time.
 */
function buildAnalyteNamePattern(): RegExp {
  const names = new Set<string>();
  for (const seed of BIOMARKER_CATALOG) {
    for (const name of localisedValues(`labs.catalog.${seed.slug}`)) {
      const folded = stripDiacritics(name.toLowerCase()).trim();
      // Also the name without its parenthetical gloss. A report prints
      // "Apolipoprotéine B", not "Apolipoprotéine B (ApoB)", and the gloss is
      // the app's way of naming a marker two ways at once.
      const bare = folded.replace(/\s*\([^)]*\)/gu, "").trim();
      for (const candidate of [folded, bare]) {
        if (candidate.length >= 4) names.add(candidate);
      }
    }
  }
  const alternation = [...names]
    .sort((a, b) => b.length - a.length)
    .map((name) =>
      name
        .split(/\s+/u)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        // Any run of whitespace, so a name broken across a transcribed line
        // still reads as one name.
        .join(String.raw`\s+`),
    )
    .join("|");
  // Bounded by "not a letter or digit" rather than by \b, because several
  // names end in punctuation ("Lipoprotéine(a)") where \b cannot match, and
  // because the Polish "ł" is not a word character to \b.
  return new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`,
    "u",
  );
}

const DERIVED_ANALYTE_NAMES = buildAnalyteNamePattern();

/** Test seam: the guard suite pins that the derived pattern covers every locale. */
export function derivedAnalyteNamePattern(): RegExp {
  return DERIVED_ANALYTE_NAMES;
}

/**
 * True when the transcribed text carries at least two distinct lab-report
 * signal classes.
 *
 * The derived analyte names extend class 3 rather than forming a class of
 * their own: a document that says "Cholestérol total" and "cholesterol" has
 * named one analyte twice, and letting that reach two would halve the gate.
 */
export function looksLikeLabDocument(text: string): boolean {
  // Fold once. The transcription is a document's worth of text and every
  // pattern needs the same folded form.
  const folded = stripDiacritics(text.toLowerCase());
  let hits = 0;
  for (const signal of LAB_SIGNALS) {
    const hit =
      signal.test(folded) ||
      (signal === ANALYTE_SIGNAL && DERIVED_ANALYTE_NAMES.test(folded));
    if (hit && ++hits >= 2) return true;
  }
  return false;
}

/** Why an auto-stage attempt did not stage — every branch leaves the manual path intact. */
export type AutoStageOutcome =
  | { staged: true; facts: number }
  | {
      staged: false;
      reason:
        | "modules-off"
        | "not-eligible"
        | "already-handled"
        | "no-text"
        | "not-lab"
        | "budget"
        | "extract-failed"
        | "raced";
    };

/**
 * Guarded `STORED → EXTRACTED` transition + PENDING fact creation in one
 * transaction. Returns the staged count, or `null` when the document was no
 * longer STORED (another writer moved it first) — the caller treats `null` as a
 * clean no-op, never an error.
 */
async function stageFactsIfStored(
  userId: string,
  documentId: string,
  result: InboundExtractionResult,
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.inboundDocument.updateMany({
      where: { id: documentId, userId, status: "STORED", deletedAt: null },
      data: {
        status: "EXTRACTED",
        providerType: result.providerType,
        reportDate: result.reportDate
          ? new Date(`${result.reportDate}T00:00:00.000Z`)
          : null,
      },
    });
    if (moved.count === 0) return null;
    if (result.facts.length === 0) return 0;
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
}

/**
 * Auto-stage lab facts for one freshly indexed document (owner-scoped). Called
 * fire-and-forget by the auto-index job after a successful index; every guard
 * miss returns a tagged no-op so the manual extract button stays the fallback.
 */
export async function maybeAutoStageLabFacts(
  userId: string,
  documentId: string,
): Promise<AutoStageOutcome> {
  const [inboundOn, labsOn] = await Promise.all([
    isModuleEnabled(userId, "inboundDocuments"),
    isModuleEnabled(userId, "labs"),
  ]);
  if (!inboundOn || !labsOn) return { staged: false, reason: "modules-off" };

  // Idempotency floor: only a still-STORED document with no facts is a
  // candidate. A re-index, the manual extract path, or the S9 cross-link all
  // leave a non-STORED / already-staged document alone.
  const doc = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: { kind: true, status: true, _count: { select: { facts: true } } },
  });
  if (!doc || doc.status !== "STORED" || doc._count.facts > 0) {
    return { staged: false, reason: "already-handled" };
  }

  // Same provider + consent gate the auto-index external path uses.
  const provider = await resolveIndexProvider(userId);
  if (!provider.pick || !provider.consentOk) {
    return { staged: false, reason: "not-eligible" };
  }

  // Reuse the transcription the auto-index just produced — no second vision call.
  const chat = await loadDocumentChatText(userId, documentId);
  if (!chat || !chat.text.trim()) return { staged: false, reason: "no-text" };

  if (doc.kind !== "LAB_RESULT" && !looksLikeLabDocument(chat.text)) {
    return { staged: false, reason: "not-lab" };
  }

  // A text-structuring pass, not a vision call — reserve the proportionate
  // ceiling under the cost owner the auto-index resolved.
  // v1.38.19 (Wave E) — auto-staging runs off the upload, with no one waiting
  // on it: a background surface, so half the day's ceiling.
  const dateKey = buildDateKey();
  const reservation = await reserveBudget(
    userId,
    AI_BUDGETS.ocrExtractText.maxTokens,
    dateKey,
    resolveDailyCapFor("job", [
      { providerType: provider.pick.entry.providerType },
    ]),
    provider.costOwner,
    "job",
  );
  if (!reservation.allowed) return { staged: false, reason: "budget" };

  let result: InboundExtractionResult;
  try {
    result = await runInboundExtraction({
      provider: provider.pick.entry.instance,
      providerType: provider.pick.providerType,
      ocrText: chat.text,
    });
    await reconcileSpend(
      userId,
      reservation.reserved,
      reservation.reserved,
      dateKey,
      0,
      {
        servedBy: provider.pick.entry.providerType,
        reservedOwner: reservation.owner,
      },
    );
  } catch (err) {
    await reconcileSpend(userId, reservation.reserved, 0, dateKey, 0, {
      servedBy: null,
      reservedOwner: reservation.owner,
    });
    if (!(err instanceof InboundExtractError)) {
      annotate({
        action: { name: "documents.autoStage.failed" },
        meta: { documentId, reason: "provider_error" },
      });
    }
    return { staged: false, reason: "extract-failed" };
  }

  const staged = await stageFactsIfStored(userId, documentId, result);
  if (staged === null) return { staged: false, reason: "raced" };

  annotate({
    action: { name: "documents.autoStage.labs" },
    meta: {
      documentId,
      facts: staged,
      provider: provider.pick.providerType,
      byKind: doc.kind === "LAB_RESULT",
    },
  });
  return { staged: true, facts: staged };
}
