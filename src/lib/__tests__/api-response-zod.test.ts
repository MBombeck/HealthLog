import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { returnAllZodIssues, sanitiseZodIssues } from "../api-response";

// v1.4.42 — every Zod-validated route historically returned
// `parsed.error.issues[0].message`, dropping every issue past the first.
// `returnAllZodIssues` is the additive replacement: clients that only
// read `error` keep working, new callers branch on `details.issues`.

const schema = z.object({
  version: z.literal(1),
  widgets: z.array(z.object({ id: z.string() })).min(1),
  comparisonBaseline: z.enum(["none", "lastMonth", "lastYear"]).optional(),
});

describe("returnAllZodIssues", () => {
  it("returns 422 by default with a sanitised issue list", async () => {
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const response = returnAllZodIssues(parsed.error);
    expect(response.status).toBe(422);

    const body = (await response.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    expect(body.details.issues[0]).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      path: expect.any(String),
    });
  });

  it("surfaces TWO simultaneous validation errors", async () => {
    const parsed = schema.safeParse({ version: 2, widgets: [] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const response = returnAllZodIssues(parsed.error);
    const body = (await response.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBe(2);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["version", "widgets"]);
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const parsed = schema.safeParse({
      version: 2,
      widgets: [],
      comparisonBaseline: "yesterday",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const response = returnAllZodIssues(parsed.error);
    const body = (await response.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBe(3);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["comparisonBaseline", "version", "widgets"]);
  });

  it("flattens nested paths with dots", async () => {
    const nested = z.object({ outer: z.object({ inner: z.string() }) });
    const parsed = nested.safeParse({ outer: { inner: 5 } });
    if (parsed.success) throw new Error("expected failure");

    const sanitised = sanitiseZodIssues(parsed.error.issues);
    expect(sanitised[0].path).toBe("outer.inner");
  });

  it("does NOT echo issue.params (privacy: may contain user input)", async () => {
    const parsed = schema.safeParse({
      version: 99,
      widgets: [{ id: "x" }],
    });
    if (parsed.success) throw new Error("expected failure");

    const response = returnAllZodIssues(parsed.error);
    const body = (await response.json()) as {
      details: { issues: Array<Record<string, unknown>> };
    };
    for (const issue of body.details.issues) {
      expect(issue).not.toHaveProperty("params");
      // Only path / code / message survive the sanitiser.
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("respects a custom status code", async () => {
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error("expected failure");
    const response = returnAllZodIssues(parsed.error, 400);
    expect(response.status).toBe(400);
  });

  it("forwards meta.errorCode and headers like apiError", async () => {
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error("expected failure");

    const response = returnAllZodIssues(parsed.error, 422, {
      errorCode: "dashboard.widgets.invalid",
      headers: { "X-Test": "yes" },
    });
    expect(response.headers.get("X-Test")).toBe("yes");
    const body = (await response.json()) as {
      meta?: { errorCode?: string; headers?: unknown };
    };
    expect(body.meta?.errorCode).toBe("dashboard.widgets.invalid");
    // Headers are consumed by the NextResponse constructor and stripped
    // from the JSON envelope, matching apiError's contract.
    expect(body.meta?.headers).toBeUndefined();
  });

  // v1.4.49 — opt-in `stripValuesFromMessage` mode for audit-ledger
  // writes. The default Zod message for `invalid_enum_value` and a
  // handful of other codes embeds the offending value verbatim; an
  // audit-row write on a free-text route would persist user content.
  // The opt-in keeps the additive multi-issue envelope shape but
  // drops `message` entirely so only `path` + `code` survive.
  describe("sanitiseZodIssues with stripValuesFromMessage", () => {
    it("returns { path, code } only when the option is set", () => {
      const enumSchema = z.object({
        kind: z.enum(["weight", "pulse"]),
      });
      const parsed = enumSchema.safeParse({ kind: "garbage-value-xxx" });
      if (parsed.success) throw new Error("expected failure");

      const stripped = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      expect(stripped.length).toBe(1);
      for (const issue of stripped) {
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
        // The offending value must not survive on any returned key.
        expect(JSON.stringify(issue)).not.toContain("garbage-value-xxx");
      }
    });

    it("default behaviour (no option) keeps message intact", () => {
      const enumSchema = z.object({
        kind: z.enum(["weight", "pulse"]),
      });
      const parsed = enumSchema.safeParse({ kind: "garbage" });
      if (parsed.success) throw new Error("expected failure");

      const kept = sanitiseZodIssues(parsed.error.issues);
      expect(kept[0]).toMatchObject({
        path: "kind",
        code: expect.any(String),
        message: expect.any(String),
      });
    });
  });
});

describe("sanitiseZodIssues — schema bounds", () => {
  it("names the declared bound of a size issue and never the rejected value", () => {
    const schema = z.object({
      value: z.number().positive().max(500),
      name: z.string().min(3),
    });
    const over = schema.safeParse({ value: 9999, name: "abc" });
    const under = schema.safeParse({ value: 0, name: "x" });
    expect(over.success || under.success).toBe(false);
    const [big] = sanitiseZodIssues(over.error!.issues);
    expect(big).toMatchObject({
      path: "value",
      code: "too_big",
      maximum: 500,
      inclusive: true,
      origin: "number",
    });
    expect(JSON.stringify(big)).not.toContain("9999");
    const small = sanitiseZodIssues(under.error!.issues, {
      stripValuesFromMessage: true,
    });
    expect(small).toEqual([
      {
        path: "value",
        code: "too_small",
        minimum: 0,
        inclusive: false,
        origin: "number",
      },
      {
        path: "name",
        code: "too_small",
        minimum: 3,
        inclusive: true,
        origin: "string",
      },
    ]);
  });

  it("adds nothing to an issue that is not about a size", () => {
    const parsed = z.object({ v: z.number() }).safeParse({ v: "nope" });
    const [issue] = sanitiseZodIssues(parsed.error!.issues);
    expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
  });
});

describe("sanitiseZodIssues — both ends from the schema", () => {
  const dose = z.object({ amount: z.number().min(0).max(5000) });

  it("puts the other declared end beside the broken one", () => {
    const parsed = dose.safeParse({ amount: 6000 });
    const [issue] = sanitiseZodIssues(parsed.error!.issues, { schema: dose });
    expect(issue).toMatchObject({
      path: "amount",
      code: "too_big",
      minimum: 0,
      maximum: 5000,
      inclusive: true,
      minimumInclusive: true,
      maximumInclusive: true,
      origin: "number",
    });
    expect(JSON.stringify(issue)).not.toContain("6000");
  });

  it("keeps the single bound without the schema, as before", () => {
    const parsed = dose.safeParse({ amount: 6000 });
    const [issue] = sanitiseZodIssues(parsed.error!.issues);
    expect(issue).not.toHaveProperty("minimum");
    expect(issue).not.toHaveProperty("minimumInclusive");
    expect(issue).toMatchObject({ maximum: 5000 });
  });

  it("walks arrays, wrappers and exclusive ends", () => {
    const schema = z.object({
      items: z.array(
        z.object({ v: z.number().gt(0).lte(10).nullable().optional() }),
      ),
    });
    const parsed = schema.safeParse({ items: [{ v: 3 }, { v: 0 }] });
    const [issue] = sanitiseZodIssues(parsed.error!.issues, {
      schema,
      stripValuesFromMessage: true,
    });
    expect(issue).toEqual({
      path: "items.1.v",
      code: "too_small",
      minimum: 0,
      maximum: 10,
      inclusive: false,
      minimumInclusive: false,
      maximumInclusive: true,
      origin: "number",
    });
  });

  it("names a string's and a list's length range", () => {
    const schema = z.object({
      label: z.string().trim().min(1).max(40),
      tags: z.array(z.string()).min(1).max(3),
    });
    const parsed = schema.safeParse({ label: "x".repeat(41), tags: [] });
    const issues = sanitiseZodIssues(parsed.error!.issues, { schema });
    expect(issues).toEqual([
      expect.objectContaining({
        path: "label",
        code: "too_big",
        minimum: 1,
        maximum: 40,
        origin: "string",
      }),
      expect.objectContaining({
        path: "tags",
        code: "too_small",
        minimum: 1,
        maximum: 3,
        origin: "array",
      }),
    ]);
  });

  it("takes the branch of a union that declared the broken bound", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), n: z.number().min(0).max(5) }),
      z.object({ kind: z.literal("b"), n: z.number().min(10).max(20) }),
    ]);
    const parsed = schema.safeParse({ kind: "b", n: 30 });
    const [issue] = sanitiseZodIssues(parsed.error!.issues, { schema });
    expect(issue).toMatchObject({
      path: "n",
      code: "too_big",
      minimum: 10,
      maximum: 20,
    });
  });

  it("adds nothing for a one-sided field or an exact length", () => {
    const schema = z.object({
      max: z.number().max(5),
      code: z.string().length(3),
    });
    const parsed = schema.safeParse({ max: 9, code: "abcd" });
    const issues = sanitiseZodIssues(parsed.error!.issues, { schema });
    for (const issue of issues) {
      expect(issue).not.toHaveProperty("minimumInclusive");
      expect(issue).not.toHaveProperty("maximumInclusive");
    }
    expect(issues[0]).not.toHaveProperty("minimum");
  });

  it("returnAllZodIssues carries both ends when given the schema", async () => {
    const parsed = dose.safeParse({ amount: -1 });
    const response = returnAllZodIssues(parsed.error!, 422, undefined, dose);
    const body = (await response.json()) as {
      details: { issues: Array<Record<string, unknown>> };
    };
    expect(body.details.issues[0]).toMatchObject({
      code: "too_small",
      minimum: 0,
      maximum: 5000,
    });
  });
});
