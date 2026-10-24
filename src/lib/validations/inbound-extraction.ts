/**
 * The provider's answer to a document extraction: UNTRUSTED model output,
 * validated fact by fact. Liberal on shape; the review screen is the safety
 * boundary. Split from `inbound-documents.ts`, which holds the staged-fact
 * DTOs, the edit and the confirm contracts.
 */
import { z } from "zod/v4";

import {
  INBOUND_DOCUMENT_KINDS,
  type InboundDocumentKindValue,
} from "@/lib/documents/inbound-constants";
import {
  INBOUND_CODE_SYSTEMS,
  INBOUND_FACT_TYPES,
} from "@/lib/validations/inbound-documents";

const confidenceScore = z.number().min(0).max(1).catch(0);
const nullableText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().catch(null);

/**
 * One fact as the PROVIDER returns it (untrusted). A single flat shape across
 * the three fact types so the wire stays simple; the route maps it to the
 * per-type staged payload. Everything is `.catch`-guarded so a malformed field
 * degrades to null + low confidence rather than 422-ing the whole extraction.
 */
const extractedFactRawFields = z.object({
  type: z.enum(INBOUND_FACT_TYPES),
  /** Verbatim label / diagnosis text / medication name as written. */
  label: z.string().trim().min(1).max(300).catch(""),
  /** STATED code, present only when the document writes one. */
  code: nullableText(64),
  codeSystem: z.enum(INBOUND_CODE_SYSTEMS).nullable().catch(null),
  /** Condition: stated clinical / verification status (verbatim). */
  clinicalStatus: nullableText(64),
  verificationStatus: nullableText(64),
  /** Observation: numeric XOR qualitative value, unit, stated ref bounds. */
  value: z.number().finite().nullable().catch(null),
  valueText: nullableText(300),
  unit: nullableText(80),
  referenceLow: z.number().finite().nullable().catch(null),
  referenceHigh: z.number().finite().nullable().catch(null),
  /**
   * Observation: the reference range EXACTLY as printed, verbatim. A report
   * writes its window in prose ("3,5 - 5,0", "< 5", "bis 5,0", "negativ"), and
   * `referenceLow` / `referenceHigh` above can only carry the cases that
   * reduce to two numbers. This field is what stops every other case from
   * being dropped on the floor — the string is kept whether or not the parser
   * gets bounds out of it.
   */
  referenceText: nullableText(120),
  /** MedicationStatement: dose + stated status (verbatim). */
  dose: nullableText(120),
  medicationStatus: nullableText(64),
  /** A stated date for the fact (onset / effective / report), ISO or null. */
  effectiveDate: z.string().nullable().catch(null),
  /** Provenance: the verbatim source span this fact came from. */
  sourceText: z.string().trim().max(2000).catch(""),
  /** Optional 0-based page index the fact was read from. */
  page: z.number().int().min(0).max(10000).nullable().catch(null),
  /** The model's self-reported overall confidence for this fact (0..1). */
  confidence: confidenceScore.default(0),
});

/**
 * A window whose floor sits above its ceiling cannot be true, so it is dropped
 * rather than repaired. Swapping the pair would invent a range the report never
 * printed, and this schema cannot reject the fact the way `labs.ts` does —
 * every field above is `.catch()`ed precisely so one bad value does not sink a
 * whole extraction. `referenceText` survives either way, so nothing the
 * document actually stated is lost: the verbatim string is still there for a
 * person to read on the review screen.
 *
 * `parseReferenceRange` already answers a transposed PRINTED window this way.
 * These are the numbers the model reported instead, and they travelled
 * unchecked: an integration run against a real Postgres wrote a 100/30 pair
 * onto the row AND onto the freshly minted catalog marker, which then handed
 * the impossible window to every later reading of that analyte.
 */
export const extractedFactRawSchema = extractedFactRawFields.transform(
  (fact) => {
    if (
      fact.referenceLow !== null &&
      fact.referenceHigh !== null &&
      fact.referenceLow > fact.referenceHigh
    ) {
      return { ...fact, referenceLow: null, referenceHigh: null };
    }
    return fact;
  },
);

export type ExtractedFactRaw = z.infer<typeof extractedFactRawSchema>;

/**
 * The JSON envelope the provider returns. Its facts are validated one by one
 * (`parseInboundExtraction`), so one malformed fact is dropped on its own
 * instead of taking every other fact of the answer with it.
 */
const inboundEnvelopeSchema = z.object({
  reportDate: z.string().nullable().catch(null),
  kind: z.enum(INBOUND_DOCUMENT_KINDS).nullable().catch(null),
  facts: z.array(z.unknown()).catch([]),
});

/** A provider answer, its facts validated. */
export interface InboundExtraction {
  reportDate: string | null;
  kind: InboundDocumentKindValue | null;
  facts: ExtractedFactRaw[];
  /** Facts in the answer that did not match the schema and were dropped. */
  droppedFacts: number;
}

/** Validate one provider answer fact by fact; null when it is not an envelope at all. */
export function parseInboundExtraction(
  json: unknown,
): InboundExtraction | null {
  const envelope = inboundEnvelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const facts: ExtractedFactRaw[] = [];
  let droppedFacts = 0;
  for (const raw of envelope.data.facts) {
    const fact = extractedFactRawSchema.safeParse(raw);
    if (fact.success) facts.push(fact.data);
    else droppedFacts += 1;
  }
  return {
    reportDate: envelope.data.reportDate,
    kind: envelope.data.kind,
    facts,
    droppedFacts,
  };
}
