"use client";

/**
 * v1.43 — client side of a supplement's composition: the nutrient catalogue
 * the form is built from, saving the composition, and reading a label photo
 * into a proposal.
 *
 * Every unit, factor and upper limit comes from the server's catalogue; the
 * form converts nothing. The label read is a background run: the route
 * answers 202 and the proposal comes from `GET /api/ai-runs/{id}`.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { resolveAiRun, type WaitForAiRunOptions } from "@/hooks/use-ai-run";
import { apiFetch, apiGet, apiPut } from "@/lib/api/api-fetch";
import type {
  AiRunAccepted,
  SupplementLabelExtractRunResult,
} from "@/lib/documents/ai-runs/types";
import type { MedicationIngredientDto } from "@/lib/medications/ingredients/composition";
import { invalidateMedicationReads, queryKeys } from "@/lib/query-keys";

export type { MedicationIngredientDto };
export type SupplementLabelProposal = SupplementLabelExtractRunResult;

export interface NutrientCatalogEntryDto {
  code: string;
  unit: string;
  labelKey: string;
  label: string;
  syncable: boolean;
  /** Whether a supplement's composition may name this code. */
  ingredient: boolean;
  inputUnits: Array<{ unit: string; factorToCanonical: number }>;
  upperLimit: {
    value: number;
    unit: string;
    scope: "total" | "supplemental";
    source: string;
  } | null;
}

/** The catalogue; only read while the composition form can open. */
export function useNutrientCatalog(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.nutrientCatalog(),
    queryFn: () =>
      apiGet<{ entries: NutrientCatalogEntryDto[] }>("/api/nutrients/catalog"),
    enabled,
    staleTime: 60 * 60 * 1000,
  });
}

export interface CompositionRowInput {
  nutrient: string;
  amount: number;
  unit: string;
}

/** Replace the composition and refresh every read it feeds. */
export async function saveComposition(
  queryClient: QueryClient,
  medicationId: string,
  ingredients: CompositionRowInput[],
  source: "MANUAL" | "LABEL_AI",
): Promise<void> {
  await apiPut(
    `/api/medications/${encodeURIComponent(medicationId)}/ingredients`,
    {
      ingredients,
      source,
    },
  );
  await invalidateMedicationReads(queryClient);
  await queryClient.invalidateQueries({ queryKey: queryKeys.nutrientsRoot() });
}

/** How long the queuing request may take: the upload and the enqueue, no model. */
const LABEL_QUEUE_REQUEST_TIMEOUT_MS = 60_000;

/** Upload a label photo and follow the background run to its proposal. */
export async function readSupplementLabel(
  queryClient: QueryClient,
  medicationId: string,
  file: File,
  progress: WaitForAiRunOptions & { onQueued?: () => void } = {},
): Promise<SupplementLabelProposal> {
  const form = new FormData();
  form.append("file", file);
  const accepted = await apiFetch<SupplementLabelProposal | AiRunAccepted>(
    `/api/medications/${encodeURIComponent(medicationId)}/ingredients/extract`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(LABEL_QUEUE_REQUEST_TIMEOUT_MS),
    },
  );
  return resolveAiRun<SupplementLabelProposal>(queryClient, accepted, progress);
}
