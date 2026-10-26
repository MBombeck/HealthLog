/**
 * v1.25 — edit a staged fact before approval.
 *
 * The review screen corrects OCR / units / dates / codes on a staged fact. A
 * successful edit rewrites the fact's FHIR-staged payload (still STATED status
 * only — the user is asserting what the document says) and clears
 * `needsReview`: a low-confidence fact that was failing closed becomes
 * user-asserted and is then eligible for approval. The fact's resource type
 * cannot change (the edit is discriminated by `factType`).
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import {
  encryptFactData,
  markerIndexForFacts,
  serialiseFact,
} from "@/lib/documents/store";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  inboundFactEditSchema,
  type ConditionFactData,
  type FactData,
  type InboundFactEdit,
  type MedicationStatementFactData,
  type ObservationFactData,
} from "@/lib/validations/inbound-documents";

type RouteParams = { params: Promise<{ id: string; factId: string }> };

export const dynamic = "force-dynamic";

/** Build the persisted FHIR-staged payload from a validated edit. */
function editToFactData(edit: InboundFactEdit): FactData {
  if (edit.factType === "CONDITION") {
    const data: ConditionFactData = {
      label: edit.label,
      code: edit.code ?? null,
      codeSystem: edit.codeSystem ?? null,
      clinicalStatus: edit.clinicalStatus ?? null,
      verificationStatus: edit.verificationStatus ?? null,
      onsetDate: edit.onsetDate ?? null,
    };
    return data;
  }
  if (edit.factType === "OBSERVATION") {
    const data: ObservationFactData = {
      label: edit.label,
      code: edit.code ?? null,
      codeSystem: edit.codeSystem ?? null,
      value: edit.value ?? null,
      valueText: edit.valueText ?? null,
      unit: edit.unit ?? null,
      referenceLow: edit.referenceLow ?? null,
      referenceHigh: edit.referenceHigh ?? null,
      referenceText: edit.referenceText ?? null,
      effectiveDate: edit.effectiveDate ?? null,
    };
    return data;
  }
  const data: MedicationStatementFactData = {
    name: edit.name,
    dose: edit.dose ?? null,
    rxNormCode: edit.rxNormCode ?? null,
    atcCode: edit.atcCode ?? null,
    statusStated: edit.statusStated ?? null,
    effectiveDate: edit.effectiveDate ?? null,
  };
  return data;
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const gate = await requireModuleEnabled(user.id, "inboundDocuments");
    if (!gate.enabled) return gate.response;

    const { id, factId } = await params;

    const fact = await prisma.extractedFact.findFirst({
      where: { id: factId, documentId: id, userId: user.id },
      select: { id: true, factType: true, status: true },
    });
    if (!fact) {
      return apiError("Fact not found", 404, {
        errorCode: "documents.inbound.factNotFound",
      });
    }
    if (fact.status !== "PENDING") {
      return apiError("Only a pending fact can be edited", 409, {
        errorCode: "documents.inbound.factNotPending",
      });
    }

    const parsed = await parseJsonBody(request, inboundFactEditSchema, {
      maxBytes: 16 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    // The edit cannot change the fact's resource type.
    if (parsed.data.factType !== fact.factType) {
      return apiError("Cannot change a fact's type", 422, {
        errorCode: "documents.inbound.factTypeMismatch",
      });
    }

    const updated = await prisma.extractedFact.update({
      where: { id: fact.id },
      data: {
        dataEncrypted: encryptFactData(editToFactData(parsed.data)),
        // The values are now user-asserted — the fail-closed gate is cleared.
        needsReview: false,
      },
    });

    annotate({
      action: { name: "documents.inbound.factEdit" },
      meta: { documentId: id, factId: fact.id, factType: fact.factType },
    });

    return apiSuccess(
      serialiseFact(updated, await markerIndexForFacts(user.id, [updated])),
    );
  },
);
