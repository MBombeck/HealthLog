/**
 * v1.38 — `scoreBasis` is additive on every wire it rides, and stays so.
 *
 * The block is new on three shapes that already ship: the full score
 * report's composite, the dashboard snapshot's flattened hero block, and
 * the daily digest's score. All three are `additionalProperties: false`,
 * and two of the three are served out of a CACHE — a snapshot or digest
 * written before this release has no way to grow a field. Declare
 * `scoreBasis` as required on any of them and every cached payload in
 * existence becomes invalid against the document that describes it on
 * the day the document is published, with nothing failing anywhere: the
 * generator is happy, `openapi:check` is happy, and the only symptom is
 * a strict client-side decoder rejecting real responses.
 *
 * That is the class this file pins. Every carrier must declare the
 * property (so a registry edit that drops it is not a green pass), must
 * NOT list it in `required`, and must point at the one shared component
 * rather than a fourth hand-rolled copy of the same object. The fields
 * that shipped before it stay required, because "additive" is a claim
 * about both directions.
 *
 * The document is BUILT rather than read off disk, the way the sharing
 * components guard does it: `scripts/check-openapi.ts` already pins
 * `docs/api/openapi.yaml` to exactly this document and CI fails on
 * drift, so building it here checks the same artifact without parsing
 * two megabytes of YAML.
 *
 * The same carriers hold the two bands, each with one meaning. `band` keeps
 * what every shipped app was built against: the worse of the number's band
 * and the worst counted pillar's band, which those apps colour the ring
 * from and explain with "X set the colour of this score". `numberBand` is
 * the band of the number alone, the rule every other HealthLog score
 * follows; the web and newer apps draw it and name the pillar beside it.
 * It is additive for the same cache reason, so it is declared on every
 * carrier and required by none.
 *
 * ## Mutation check
 *
 * Drop `.optional()` from any of the three registry declarations and the
 * matching `required` assertion goes red. Delete a declaration entirely
 * and the presence assertion goes red first. The same holds for
 * `numberBand`. The engine side (`band` red, `numberBand` green for a green
 * number over a red pillar) is pinned in `composite.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/openapi/registry";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  oneOf?: Schema[];
  $ref?: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
};

const doc = buildOpenApiDocument() as unknown as {
  components?: { schemas?: Record<string, Schema> };
};
const schemas = doc.components?.schemas ?? {};

const BASIS_REF = "#/components/schemas/HealthScoreBasis";

/**
 * Walk a schema tree and collect every object that declares a
 * `scoreBasis` property, wherever it is nested.
 *
 * Written as a walk rather than a path lookup on purpose: the three
 * shapes sit at three very different depths (a component's union arm, a
 * deeply nested snapshot object, a nullable digest member), and a
 * hand-written path per surface is a fourth restatement of the contract
 * that can rot without anybody noticing.
 */
function objectsCarryingScoreBasis(root: unknown): Schema[] {
  const found: Schema[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const schema = node as Schema;
    if (schema.properties && "scoreBasis" in schema.properties) {
      found.push(schema);
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value);
    }
  };
  visit(root);
  return found;
}

describe("the score basis is published, and published as optional", () => {
  it("declares the shared component once", () => {
    const basis = schemas.HealthScoreBasis;
    expect(
      basis,
      "HealthScoreBasis is not a published component",
    ).toBeDefined();
    expect(Object.keys(basis?.properties ?? {}).sort()).toEqual([
      "domains",
      "physiological",
      "recommended",
      "tier",
    ]);
    // The tier vocabulary is the whole label. A client reads it verbatim,
    // so the members are pinned rather than left to the enum's shape.
    expect(basis?.properties?.tier?.enum).toEqual([
      "full",
      "partial",
      "minimal",
    ]);
    // Inside the component the four fields ARE required — the block is
    // all-or-nothing. Optionality lives on the shapes that carry it, not
    // on its own members, and confusing the two is how a "yes it is
    // optional" answer ends up being about the wrong object.
    expect([...(basis?.required ?? [])].sort()).toEqual([
      "domains",
      "physiological",
      "recommended",
      "tier",
    ]);
  });

  it("is carried by every score-bearing shape, and required by none", () => {
    const carriers = objectsCarryingScoreBasis(schemas);
    const composites = carriers.filter(
      (carrier) => carrier.properties?.scoreBasis?.$ref === BASIS_REF,
    );

    // The non-zero control, and it does double duty. Three surfaces carry
    // a composite score — the report's composite, the dashboard
    // snapshot's hero block, the daily digest's score — and each is
    // counted only if it points at the shared component, so an inlined
    // fourth copy of the object drops the count rather than passing as a
    // carrier. A walk that stopped matching reports zero and fails,
    // instead of reporting a green run over nothing.
    expect(composites.length).toBeGreaterThanOrEqual(3);

    for (const carrier of carriers) {
      expect(carrier.required ?? []).not.toContain("scoreBasis");
    }
  });

  it("declares band and numberBand on every carrier, band required, numberBand optional", () => {
    const composites = objectsCarryingScoreBasis(schemas).filter(
      (carrier) => carrier.properties?.scoreBasis?.$ref === BASIS_REF,
    );
    expect(composites.length).toBeGreaterThanOrEqual(3);
    for (const carrier of composites) {
      expect(carrier.properties).toHaveProperty("band");
      expect(carrier.properties).toHaveProperty("numberBand");
      expect(carrier.required ?? []).toContain("band");
      expect(carrier.required ?? []).not.toContain("numberBand");
      expect(carrier.properties?.band?.description).toMatch(/worst/i);
      expect(carrier.properties?.numberBand?.description).toMatch(/number/i);
    }
  });

  it("does not confuse the composite's basis with a pillar's", () => {
    // `scoreBasis` is an older field name on `PillarValue`, where blood
    // pressure uses it to say which of its two axes produced the number.
    // Same key, different object, on a shape that also rides the score
    // report — so the walk above finds it, and the assertion that every
    // carrier `$ref`s the composite component would have been wrong.
    // Pinned here so a future reader does not "fix" that by widening the
    // composite component to swallow the pillar's field.
    const carriers = objectsCarryingScoreBasis(schemas);
    const pillarBasis = carriers.filter(
      (carrier) => carrier.properties?.scoreBasis?.$ref !== BASIS_REF,
    );
    expect(pillarBasis.length).toBeGreaterThan(0);
    for (const carrier of pillarBasis) {
      expect(carrier.properties?.scoreBasis?.type).toBe("object");
      expect(
        Object.keys(carrier.properties?.scoreBasis?.properties ?? {}),
      ).toContain("axis");
    }
  });

  it("keeps the fields that shipped before it required", () => {
    // The other half of "additive": adding a field must not have
    // loosened anything that was already load-bearing. `composition` and
    // `configured` are read by iOS on the composite, and a silently
    // optional `composition` would be a contract break wearing the
    // additive change's clothes.
    const composite = schemas.DerivedHealthScoreComposite;
    expect(composite, "DerivedHealthScoreComposite is missing").toBeDefined();
    const okArm = (composite?.anyOf ?? composite?.oneOf ?? []).find((arm) =>
      arm.properties?.value?.properties
        ? "scoreBasis" in arm.properties.value.properties
        : false,
    );
    expect(okArm, "the ok arm of the composite is missing").toBeDefined();
    const value = okArm?.properties?.value;
    expect([...(value?.required ?? [])].sort()).toEqual([
      "band",
      "bandSetter",
      "composition",
      "configured",
      "noiseFloor",
      "score",
      "scoreVersion",
    ]);
  });
});
