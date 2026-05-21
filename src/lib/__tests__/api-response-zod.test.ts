import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  returnAllZodIssues,
  sanitiseZodIssues,
} from "../api-response";

// v1.4.42 W2 — every Zod-validated route historically returned
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
      details: { issues: Array<{ path: string; code: string; message: string }> };
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
});
