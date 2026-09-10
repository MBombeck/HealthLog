/**
 * v1.39 (C1) — reading the needs-onboarding row, for the payload and for the
 * three writes.
 *
 * One place that turns an `OnboardingRecord` row (or its absence) into the
 * published DTO, so `GET /api/auth/me` and the write routes cannot disagree
 * about what "nothing answered yet" looks like. A record with no row reads as
 * empty answers and nine pending steps rather than as a missing object — a
 * client then never branches on absence, and the account payload stays
 * additive for every account that predates the flow.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  parseOnboardingFirstResult,
  parseOnboardingNeeds,
  parseOnboardingSteps,
  type OnboardingStateDto,
} from "./needs";
import type { OnboardingRecordState } from "./needs-apply";

/** The columns every reader below needs. */
export const ONBOARDING_RECORD_SELECT = {
  needsJson: true,
  stepsJson: true,
  firstResultJson: true,
  modulesDerivedAt: true,
  completedAt: true,
} as const;

export interface OnboardingRecordRow {
  needsJson: unknown;
  stepsJson: unknown;
  firstResultJson: unknown;
  modulesDerivedAt: Date | null;
  completedAt: Date | null;
}

/** The answers / steps / first result, parsed fail-soft. */
export function readOnboardingRecordState(
  row: OnboardingRecordRow | null,
): OnboardingRecordState {
  if (!row) {
    return {
      needs: emptyOnboardingNeeds(),
      steps: defaultOnboardingSteps(),
      firstResult: null,
    };
  }
  return {
    needs: parseOnboardingNeeds(row.needsJson),
    steps: parseOnboardingSteps(row.stepsJson),
    firstResult: parseOnboardingFirstResult(row.firstResultJson),
  };
}

/** The shape published on the account payload. */
export function toOnboardingStateDto(
  row: OnboardingRecordRow | null,
): OnboardingStateDto {
  const state = readOnboardingRecordState(row);
  return {
    steps: state.steps,
    needs: state.needs,
    completedAt: row?.completedAt?.toISOString() ?? null,
    firstResult: state.firstResult,
  };
}

/**
 * Load the published state for one record.
 *
 * Takes the delegate rather than the whole client, matching the section
 * builders next door, so the route's global client and a worker's local one
 * share the same read.
 */
export async function loadOnboardingState(
  prisma: Pick<PrismaClient, "onboardingRecord">,
  recordId: string,
): Promise<OnboardingStateDto> {
  const row = await prisma.onboardingRecord.findUnique({
    where: { userId: recordId },
    select: ONBOARDING_RECORD_SELECT,
  });
  return toOnboardingStateDto(row);
}
