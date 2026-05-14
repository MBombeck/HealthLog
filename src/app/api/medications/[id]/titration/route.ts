/**
 * v1.4.25 W19f — GLP-1 titration-ladder read endpoint.
 *
 *   GET /api/medications/[id]/titration
 *     - returns the EMA-reference ladder for the medication's drug,
 *       the user's current step (matched within ±10 % tolerance to
 *       their latest dose), how long they've been on that step, the
 *       immediate-next step (if any), and the observational
 *       escalation-due flag.
 *
 * Pure computation — no writes. Delegates math to the
 * `src/lib/medications/titration/ladder` module so the route, the
 * Coach snapshot (future wave), and the detail-page section all read
 * the same numbers.
 *
 * Auth: cookie-session via requireAuth(); medication is verified to
 * belong to the caller before any read. Defence-in-depth: returns
 * 404 for non-GLP-1 medications (the UI already gates on
 * `treatmentClass === "GLP1"`).
 */

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  findDrugByBrand,
  findDrugIdByBrand,
} from "@/lib/medications/glp1-knowledge";
import { parseDoseMgOrNull } from "@/lib/medications/dose-string";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import {
  escalationDue,
  findCurrentStep,
  ladderFromRecord,
  nextStep,
  weeksOnCurrentStep,
} from "@/lib/medications/titration/ladder";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper so
    // the 404 leak shape stays consistent across every medication
    // sub-route.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      include: {
        doseChanges: { orderBy: { effectiveFrom: "asc" } },
      },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }
    if (med.treatmentClass !== "GLP1") {
      // Defence-in-depth: the UI already gates the section on this
      // class, but the route refuses to surface the ladder for a
      // non-GLP-1 row so we never leak a misleading "you are here"
      // on a generic medication.
      return apiError("Medication not found", 404);
    }

    // Resolve the GLP-1 drug record from the medication name. Same
    // path the DrugLevelChart uses; null when the medication name
    // doesn't map to a catalog brand (e.g. user typed a generic
    // INN instead of a brand). v1.4.25 W21 Fix-N — both lookups go
    // through the shared helpers in glp1-knowledge.
    const record = findDrugByBrand(med.name);
    const drugId = findDrugIdByBrand(med.name);
    if (!record || !drugId) {
      return apiError("Medication not found", 404);
    }

    const ladder = ladderFromRecord(record);

    // Resolve the user's most-recent dose. Prefer the
    // MedicationDoseChange stream (the history of record); fall back
    // to the legacy free-text `medication.dose` if the stream is empty.
    const latestChange =
      med.doseChanges.length > 0
        ? med.doseChanges[med.doseChanges.length - 1]
        : null;
    const latestDoseMg = latestChange
      ? latestChange.doseValue
      : parseDoseMgOrNull(med.dose);

    const currentStep = findCurrentStep(drugId, latestDoseMg);
    const next = nextStep(drugId, currentStep);
    const asOf = new Date();
    const weeks = weeksOnCurrentStep(
      drugId,
      currentStep,
      med.doseChanges.map((dc) => ({
        effectiveFrom: dc.effectiveFrom,
        doseValue: dc.doseValue,
      })),
      asOf,
    );
    const due = escalationDue(drugId, currentStep, weeks);

    annotate({
      action: {
        name: "medication.titration",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        drug_id: drugId,
        step_index: currentStep?.stepIndex ?? null,
        weeks_on_step: weeks,
      },
    });

    return apiSuccess({
      drugId,
      drugInn: record.inn,
      ladder,
      currentStep,
      currentStepIndex: currentStep?.stepIndex ?? null,
      weeksOnCurrentStep: weeks,
      nextStep: next,
      escalationDue: due,
      sourceEMA: record.sourceEMA,
    });
  },
);

