/**
 * OpenAPI route table — official medication leaflets, step 1 (#1430).
 *
 * The person's medicine registry (`PATCH /api/auth/me/medicine-registry`,
 * published on `/api/auth/me` as `medicineRegistry`), the registry search
 * link on the medication list and detail (`leafletSearch`), and the saved
 * leaflet link
 * (`leafletUrl`, on the medication resource and the create and update
 * bodies). Nothing here makes the server fetch anything.
 *
 * Part of the medication route table; aggregated in `../index.ts`.
 */
import type { ZodOpenApiObject } from "zod-openapi";
import { z } from "zod/v4";

import {
  MEDICINE_REGISTRIES,
  MEDICINE_REGISTRY_CHOICES,
} from "@/lib/medications/leaflet-registries";
import { medicineRegistryPatchSchema } from "@/lib/validations/user-prefs";

import { dataEnvelope, stdResponses } from "../shared";
import { cappedScalarBodyRefusals } from "../profile";

const REGISTRY_LIST = MEDICINE_REGISTRIES.map((r) => `\`${r}\``).join(", ");

/** The setting's value, as `/api/auth/me` publishes it. */
export const medicineRegistryField = z
  .enum(MEDICINE_REGISTRY_CHOICES)
  .describe(
    `#1430 — which official medicine registry the "Find leaflet" link opens: an ISO 3166 alpha-2 country code (${REGISTRY_LIST}; \`GB\` is the United Kingdom, \`EU\` the European Medicines Agency), or \`NONE\` for no leaflet search. Independent of the interface language. Never null: an account that never chose one has it derived once from its language and time zone where the two agree on one registry, otherwise \`NONE\`, and stored, so a later change of language does not move it. Set it with \`PATCH /api/auth/me/medicine-registry\`. Clients show and edit it; the link itself comes ready-built on the medication list and detail as \`leafletSearch\`.`,
  );

export const leafletSearchResource = z
  .object({
    registry: z.enum(MEDICINE_REGISTRIES),
    authority: z
      .string()
      .describe(
        'Who runs the search the link opens, as a proper name ("DailyMed", "AEMPS CIMA"). Not translated.',
      ),
    url: z
      .string()
      .describe(
        "The registry's own search page, ready to open in a browser (a new tab, or an in-app browser). Always `https:` on `host`. Built by the server from a static table; the server never requests it.",
      ),
    host: z
      .string()
      .describe(
        "The registry's host, for a label that names where the link goes.",
      ),
    prefill: z
      .enum(["nameAndStrength", "name", "none"])
      .describe(
        "How much of the medication the link carries. `nameAndStrength` and `name`: the registry opens on its results for `searchTerm`. `none`: the registry's search takes nothing from its address, so the page opens empty and the client asks the person to search for `searchTerm` there.",
      ),
    searchTerm: z
      .string()
      .describe(
        "What is searched for: the medication name, plus the strength when `prefill` is `nameAndStrength` and the dose reads as one.",
      ),
  })
  .nullable()
  .meta({
    id: "MedicationLeafletSearch",
    description:
      "#1430 — the official registry search for this medication, built for the CALLER's `medicineRegistry` (the person who will open it, not the record's owner). NULL when the caller chose `NONE`. Remind the person that the leaflet comes from the national registry and that they should check it matches the medication's name, strength and form.",
  });

/** `leafletUrl` on the medication resource. */
export const leafletUrlResourceField = z
  .string()
  .nullable()
  .describe(
    '#1430 — the official leaflet the person saved for this medication: an `https:` URL, any host. NULL = none saved. Show it only as an external link (a new tab, `rel="noopener noreferrer"` on the web); never fetch or embed it. Set or cleared through `leafletUrl` on the create and update bodies.',
  );

const medicineRegistryPatchRequest = medicineRegistryPatchSchema.meta({
  id: "MedicineRegistryPatchRequest",
  description:
    "Which official medicine registry the leaflet search opens, or `NONE`.",
});

const medicineRegistryResponse = z
  .object({ medicineRegistry: z.enum(MEDICINE_REGISTRY_CHOICES) })
  .meta({ id: "MedicineRegistryResponse" });

export const medicineRegistryPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/auth/me/medicine-registry": {
    patch: {
      tags: ["Auth"],
      summary: "Set the medicine registry for leaflet searches",
      description:
        "Which country's official medicine registry (or the EU's) the \"Find leaflet\" link on a medication opens, or `NONE` to hide it. Independent of the interface language. The current value is `medicineRegistry` on `/api/auth/me`.\n\nHard-set, idempotent, audit-logged. Rate-limited 60 / min per user. A value outside the list is 422. The caller's own setting: under a switched session it is still the caller's.\n\nThe body is capped at 1 KB and must carry `Content-Type: application/json`. Anything larger is 413, a wrong content type is 415, and a body that is not JSON at all is 400 — the same three the other scalars in this group answer.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: medicineRegistryPatchRequest },
        },
      },
      responses: {
        "200": {
          description: "The stored registry.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                medicineRegistryResponse,
                "PatchMedicineRegistryEnvelope",
              ),
            },
          },
        },
        ...cappedScalarBodyRefusals,
        ...stdResponses,
      },
    },
  },
};
