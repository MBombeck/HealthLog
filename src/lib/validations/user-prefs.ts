/**
 * Request schemas for the per-user scalar preference endpoints under
 * `/api/auth/me/*`. Single-sourced here so the runtime `safeParse` and the
 * OpenAPI registry (`src/lib/openapi/routes/profile.ts`) describe the identical
 * wire contract — the same reason `mfa.ts` exists next door.
 *
 * They all follow the same shape: a one-field PATCH that hard-sets the value
 * and answers with the resolved next state, so a client can replace its
 * optimistic update rather than re-read.
 */
import { z } from "zod/v4";

import {
  injectionSiteEnum,
  INJECTION_SITE_VALUES,
} from "@/lib/validations/medication";
import { MEDICINE_REGISTRY_CHOICES } from "@/lib/medications/leaflet-registries";

/** `PATCH /api/auth/me/unit-preference` — metric/imperial display branch. */
export const unitPreferencePatchSchema = z.object({
  unitPreference: z.enum(["metric", "imperial"]),
});

/**
 * `PATCH /api/auth/me/glucose-unit` — mg/dL vs mmol/L display branch.
 *
 * Not the metric/imperial preference: the two split along different lines.
 * Germany is metric and reads glucose in mg/dL; the UK and the Nordics read
 * it in mmol/L. Canonical storage stays mg/dL either way.
 */
export const glucoseUnitPatchSchema = z.object({
  glucoseUnit: z.enum(["mg/dL", "mmol/L"]),
});

/**
 * `PATCH /api/auth/me/medicine-registry` (#1430) — which country's official
 * medicine registry the "Find leaflet" link opens, or `NONE`. Independent of
 * the interface language.
 */
export const medicineRegistryPatchSchema = z.object({
  medicineRegistry: z.enum(MEDICINE_REGISTRY_CHOICES),
});

/** `PATCH /api/auth/me/documents-auto-ai-read` — the auto-read opt-in. */
export const documentsAutoAiReadPatchSchema = z.object({
  documentsAutoAiRead: z.boolean(),
});

/** `PATCH /api/auth/me/labs-local-ocr` — browser-side OCR opt-in. */
export const labsLocalOcrPatchSchema = z.object({
  labsLocalOcrEnabled: z.boolean(),
});

/** `PATCH /api/auth/me/workout-routes` — keep workout GPS tracks (opt-in). */
export const workoutRoutesPatchSchema = z.object({
  storeWorkoutRoutes: z.boolean(),
});

/** `PATCH /api/auth/me/use-central-codex` — the operator's shared Codex. */
export const useCentralCodexPatchSchema = z.object({
  useCentralCodex: z.boolean(),
});

/** `PATCH /api/auth/me/injection-site-prefs` — the user-level deny-list. */
export const injectionSitePrefsPatchSchema = z.object({
  // Dedup at write time; cap at the full enum size. An empty array
  // clears the exclusion.
  globalExcludedInjectionSites: z
    .array(injectionSiteEnum)
    .max(INJECTION_SITE_VALUES.length)
    .meta({
      description:
        "User-level injection-site deny-list. Sites here are never offered for any medication and rejected at intake (deny wins). Empty array clears the exclusion.",
    }),
});
