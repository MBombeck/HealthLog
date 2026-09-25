/**
 * v1.39.1 — every wire change in this release is additive for the iPhone app
 * already in people's hands (1.0.3 in the App Store, 1.0.4 on TestFlight).
 *
 * What changed on shapes those builds decode:
 *
 *   - `AppleHealthBatchEntryResult` gained `convertedValue` and `range`, on a
 *     `value_out_of_range` skip only;
 *   - the batch validation 422 gained `meta.errorCode`;
 *   - `ProfileResponse.timezone` now holds the resolved zone (same type);
 *   - the nutrient and cycle batch responses gained a `Cache-Control` header
 *     on one outcome, and the nutrient entry's description changed.
 *
 * Two directions are pinned, because "additive" is a claim about both:
 *
 *   1. A payload the new server sends still decodes with a decoder written
 *      against the old shape. The decoders below are that: the fields the
 *      shipped client reads non-optionally, with their types, and nothing
 *      else — unknown keys are ignored, as Swift's `Decodable` ignores them.
 *   2. A payload of the old shape still satisfies the new document: no field
 *      a shipped client might omit or never see became required.
 *
 * The document is built from the registry rather than read off disk;
 * `openapi:check` already pins the YAML to exactly this build.
 *
 * ## Mutation check
 *
 * Drop `.optional()` from `convertedValue` or `range` in the registry and the
 * `required` assertion goes red. Rename a field the old decoder reads and the
 * decode assertion goes red.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { buildOpenApiDocument } from "@/lib/openapi/registry";

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  $ref?: string;
  anyOf?: Schema[];
};

const doc = buildOpenApiDocument() as unknown as {
  components: { schemas: Record<string, Schema> };
};
const schemas = doc.components.schemas;

function component(name: string): Schema {
  const found = schemas[name];
  if (!found) throw new Error(`component ${name} is missing`);
  return found;
}

// ── The shapes as 1.0.3 decodes them ────────────────────────────────────

const oldBatchEntry = z.object({
  index: z.number().int(),
  status: z.string(),
  reason: z.string().optional(),
});

const oldBatchResponse = z.object({
  data: z.object({
    processed: z.number(),
    inserted: z.number(),
    updated: z.number(),
    duplicates: z.number(),
    failed: z.number(),
    skipped: z.array(z.object({ index: z.number(), reason: z.string() })),
    entries: z.array(oldBatchEntry),
  }),
});

const oldErrorEnvelope = z.object({
  data: z.null(),
  error: z.string(),
});

const oldProfile = z.object({
  data: z.object({
    username: z.string(),
    email: z.string().nullable(),
    timezone: z.string(),
    timeFormat: z.string(),
    dateFormat: z.string(),
    moodReminderEnabled: z.boolean(),
  }),
});

const oldNutrientResponse = z.object({
  data: z.object({
    processed: z.number(),
    inserted: z.number(),
    updated: z.number(),
    skipped: z.array(z.object({ index: z.number(), reason: z.string() })),
    entries: z.array(
      z.object({
        index: z.number(),
        status: z.string(),
        reason: z.string().optional(),
      }),
    ),
  }),
});

// ── Fixtures ────────────────────────────────────────────────────────────

/** A v1.39.0 batch answer: no range detail anywhere. */
const OLD_BATCH = {
  data: {
    processed: 2,
    inserted: 1,
    updated: 0,
    duplicates: 0,
    failed: 0,
    skipped: [{ index: 1, reason: "value_out_of_range" }],
    entries: [
      { index: 0, status: "inserted" },
      { index: 1, status: "skipped", reason: "value_out_of_range" },
    ],
  },
  error: null,
};

/** The same batch answered by v1.39.1. */
const NEW_BATCH = {
  data: {
    ...OLD_BATCH.data,
    entries: [
      { index: 0, status: "inserted" },
      {
        index: 1,
        status: "skipped",
        reason: "value_out_of_range",
        convertedValue: 90,
        range: { min: 1, max: 80, unit: "%" },
      },
    ],
  },
  error: null,
};

const NEW_BATCH_422 = {
  data: null,
  error: "Invalid input: expected string, received undefined",
  details: {
    issues: [{ path: ["entries", 0, "unit"], message: "Required" }],
  },
  meta: { errorCode: "measurement.batch.invalid" },
};

const NEW_PROFILE = {
  data: {
    username: "someone",
    displayName: null,
    email: null,
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    locale: null,
    timezone: "Europe/Berlin",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    moodReminderEnabled: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    modules: {},
  },
  error: null,
};

const NEW_NUTRIENTS = {
  data: {
    processed: 1,
    inserted: 0,
    updated: 0,
    skipped: [{ index: 0, reason: "upsert_failed" }],
    entries: [{ index: 0, status: "skipped", reason: "upsert_failed" }],
  },
  error: null,
};

describe("v1.39.1 — shipped decoders still decode what the server now sends", () => {
  it("the batch answer, with the new range detail", () => {
    expect(oldBatchResponse.safeParse(NEW_BATCH).success).toBe(true);
  });

  it("the batch validation 422, with its new code", () => {
    expect(oldErrorEnvelope.safeParse(NEW_BATCH_422).success).toBe(true);
  });

  it("the profile, whose timezone is still a string", () => {
    expect(oldProfile.safeParse(NEW_PROFILE).success).toBe(true);
  });

  it("the nutrient batch answer carrying upsert_failed", () => {
    expect(oldNutrientResponse.safeParse(NEW_NUTRIENTS).success).toBe(true);
  });
});

describe("v1.39.1 — the new document still admits the old shapes", () => {
  it("adds convertedValue and range to the batch entry as optional fields", () => {
    const entry = component("AppleHealthBatchEntryResult");
    expect(entry.properties?.convertedValue?.type).toBe("number");
    expect(
      Object.keys(entry.properties?.range?.properties ?? {}).sort(),
    ).toEqual(["max", "min", "unit"]);
    expect([...(entry.required ?? [])].sort()).toEqual(["index", "status"]);
  });

  it("an old batch entry carries every field the new document requires", () => {
    const required = component("AppleHealthBatchEntryResult").required ?? [];
    for (const e of OLD_BATCH.data.entries) {
      for (const key of required) expect(e).toHaveProperty(key);
    }
  });

  it("keeps the error envelope's meta optional", () => {
    const envelope = component("ErrorEnvelope");
    expect(envelope.required ?? []).not.toContain("meta");
    expect(envelope.properties?.meta?.required ?? []).not.toContain(
      "errorCode",
    );
  });

  it("keeps the profile timezone a required string", () => {
    const profile = component("ProfileResponse");
    expect(profile.properties?.timezone?.type).toBe("string");
    expect(profile.required).toContain("timezone");
  });

  it("keeps the nutrient entry result's shape", () => {
    const entry = component("NutrientEntryResult");
    expect(Object.keys(entry.properties ?? {}).sort()).toEqual([
      "index",
      "reason",
      "status",
    ]);
    expect([...(entry.required ?? [])].sort()).toEqual(["index", "status"]);
  });

  it("puts the named sleep-stage answer beside the old create response, not in place of it", () => {
    const named = component("NamedSleepStageMeasurement");
    expect(named.required).toContain("status");
    const resource = component("MeasurementResource");
    expect(resource.properties).not.toHaveProperty("status");
  });
});
