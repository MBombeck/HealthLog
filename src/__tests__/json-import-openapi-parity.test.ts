/**
 * The published JSON import contract names the fields the import reads.
 *
 * `src/lib/openapi/routes/import.ts` restates `jsonImportSchema` by hand,
 * because the runtime schema carries transforms the document describes in
 * prose. A restatement drifts: a field the import learns to read stays
 * undocumented, and one it stops reading stays promised. So the two field
 * sets are compared here, per row kind, both ways.
 */
import { describe, expect, it } from "vitest";

import {
  jsonImportMeasurementSchema,
  jsonImportMoodContextSchema,
  jsonImportMoodEntrySchema,
} from "@/lib/import/json/schema";
import { buildOpenApiDocument } from "@/lib/openapi/registry";

type SchemaObject = {
  properties?: Record<string, SchemaObject>;
  $ref?: string;
  allOf?: SchemaObject[];
};

const doc = buildOpenApiDocument() as {
  components: { schemas: Record<string, SchemaObject> };
};

function resolve(schema: SchemaObject): SchemaObject {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    return resolve(doc.components.schemas[name]!);
  }
  if (schema.allOf) {
    return {
      properties: Object.assign(
        {},
        ...schema.allOf.map((part) => resolve(part).properties ?? {}),
      ),
    };
  }
  return schema;
}

function documented(name: string): string[] {
  const schema = doc.components.schemas[name];
  expect(schema, `${name} is published`).toBeDefined();
  return Object.keys(resolve(schema!).properties ?? {}).sort();
}

describe("the published JSON import contract", () => {
  it("names every measurement field the import reads, and no other", () => {
    const fields = documented("JsonImportMeasurement");
    expect(fields.length).toBeGreaterThan(5);
    expect(fields).toEqual(
      Object.keys(jsonImportMeasurementSchema.shape).sort(),
    );
  });

  it("names every mood-entry field the import reads, and no other", () => {
    const fields = documented("JsonImportMoodEntry");
    expect(fields.length).toBeGreaterThan(5);
    expect(fields).toEqual(Object.keys(jsonImportMoodEntrySchema.shape).sort());
  });

  it("names every day-context field the import reads, and no other", () => {
    const entry = resolve(doc.components.schemas.JsonImportMoodEntry!);
    const context = resolve(entry.properties!.context!);
    const fields = Object.keys(context.properties ?? {}).sort();
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toEqual(
      Object.keys(jsonImportMoodContextSchema.shape).sort(),
    );
  });
});
