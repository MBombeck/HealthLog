/**
 * Two bands on every health-score wire, each with one meaning.
 *
 * `band` keeps the meaning every shipped app was built against: the worse
 * of the number's band and the worst counted pillar's band. Those apps
 * colour the ring from it and explain it with "X set the colour of this
 * score", so a `band` that followed the number would draw a green ring over
 * a red pillar and then blame the pillar for the green.
 *
 * `numberBand` is the band of the number alone, the rule every other
 * HealthLog score follows. The web and newer apps draw it and name the
 * pillar beside it (`bandSetterLine`). It is additive: the snapshot and the
 * digest are served out of caches written before it existed, so it is
 * declared on every carrier and required by none.
 *
 * The carriers are found by walking the built document for every object
 * that points at the shared `HealthScoreBasis` component, the same walk the
 * basis contract uses, so a fourth carrier cannot slip past by being new.
 *
 * ## Mutation check
 *
 * Drop `numberBand` from one registry declaration and the presence
 * assertion fails for that carrier. Mark it required and the optionality
 * assertion fails. The engine side (`band` red, `numberBand` green for a
 * green number over a red pillar) is pinned in `composite.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/openapi/registry";

type Schema = {
  properties?: Record<string, Schema>;
  required?: string[];
  $ref?: string;
  description?: string;
};

const doc = buildOpenApiDocument() as unknown as {
  components?: { schemas?: Record<string, Schema> };
};
const BASIS_REF = "#/components/schemas/HealthScoreBasis";

function compositeCarriers(root: unknown): Schema[] {
  const found: Schema[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const schema = node as Schema;
    if (schema.properties?.scoreBasis?.$ref === BASIS_REF) found.push(schema);
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value);
    }
  };
  visit(root);
  return found;
}

describe("every health-score wire carries band and numberBand", () => {
  const carriers = compositeCarriers(doc.components?.schemas ?? {});

  it("finds the carriers", () => {
    // The report's composite, the snapshot's hero block, the digest's score.
    expect(carriers.length).toBeGreaterThanOrEqual(3);
  });

  it("declares both, keeps band required where it was, numberBand optional", () => {
    for (const carrier of carriers) {
      expect(carrier.properties).toHaveProperty("band");
      expect(carrier.properties).toHaveProperty("numberBand");
      expect(carrier.required ?? []).toContain("band");
      expect(carrier.required ?? []).not.toContain("numberBand");
      expect(carrier.properties?.band?.description).toMatch(/worst/i);
      expect(carrier.properties?.numberBand?.description).toMatch(/number/i);
    }
  });
});
