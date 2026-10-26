import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { parseJsonBody } from "@/lib/api/body";
import {
  apiValidationError,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { eventStorage } from "@/lib/logging/context";

const schema = z.object({ name: z.string().min(1), count: z.number().int() });

function post(body: string, contentType = "application/json"): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

/** Status and JSON body of a response, for byte-level comparison. */
async function snapshot(res: Response) {
  return { status: res.status, body: await res.text() };
}

function issuesOf(input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("fixture must be invalid");
  return result.error;
}

async function withEvent<T>(fn: () => Promise<T>) {
  const evt = new WideEventBuilder("http");
  const result = await eventStorage.run(evt, fn);
  return { result, event: evt.toJSON() };
}

describe("parseJsonBody", () => {
  it("returns the schema's output and the decoded body", async () => {
    const parsed = await parseJsonBody(
      post(JSON.stringify({ name: "a", count: 2, extra: true })),
      schema,
    );
    expect(parsed).toEqual({
      ok: true,
      data: { name: "a", count: 2 },
      body: { name: "a", count: 2, extra: true },
    });
  });

  it("refuses a wrong content type, an oversized body and malformed JSON as safeJson does", async () => {
    const wrongType = await parseJsonBody(post("{}", "text/plain"), schema);
    const tooLarge = await parseJsonBody(
      post(`{"name":"${"x".repeat(64)}"}`),
      schema,
      {
        maxBytes: 16,
      },
    );
    const malformed = await parseJsonBody(post("{"), schema);
    const statuses = [wrongType, tooLarge, malformed].map((p) =>
      p.ok ? 0 : p.error.status,
    );
    expect(statuses).toEqual([415, 413, 400]);
  });

  it("answers a validation failure with returnAllZodIssues' exact bytes", async () => {
    const input = { name: "", count: 1.5 };
    const parsed = await parseJsonBody(post(JSON.stringify(input)), schema);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(await snapshot(parsed.error)).toEqual(
      await snapshot(returnAllZodIssues(issuesOf(input), 422)),
    );
  });

  it("carries the error code, status and message the route names", async () => {
    const input = { name: 3 };
    const coded = await parseJsonBody(post(JSON.stringify(input)), schema, {
      errorCode: "thing.invalid",
    });
    const worded = await parseJsonBody(post(JSON.stringify(input)), schema, {
      message: "Invalid input",
      errorCode: "thing.invalid",
      status: 400,
    });
    if (coded.ok || worded.ok) throw new Error("expected refusals");
    expect(await snapshot(coded.error)).toEqual(
      await snapshot(
        returnAllZodIssues(issuesOf(input), 422, {
          errorCode: "thing.invalid",
        }),
      ),
    );
    expect(await snapshot(worded.error)).toEqual(
      await snapshot(
        apiValidationError(
          "Invalid input",
          sanitiseZodIssues(issuesOf(input).issues),
          400,
          { errorCode: "thing.invalid" },
        ),
      ),
    );
  });

  it("validates what `input` derives from the body", async () => {
    const parsed = await parseJsonBody(post("null"), schema.partial(), {
      input: (body) => body ?? {},
    });
    expect(parsed).toEqual({ ok: true, data: {}, body: null });
  });

  it("stamps the action, the issue count and the extra meta on a refusal only", async () => {
    const options = {
      action: "thing.validation-failed",
      countIssues: true,
      meta: { thingId: "t1" },
    };
    const refused = await withEvent(() =>
      parseJsonBody(post(JSON.stringify({ name: "" })), schema, options),
    );
    expect(refused.event.action).toEqual({ name: "thing.validation-failed" });
    expect(refused.event.meta).toMatchObject({ issue_count: 2, thingId: "t1" });

    const accepted = await withEvent(() =>
      parseJsonBody(
        post(JSON.stringify({ name: "a", count: 1 })),
        schema,
        options,
      ),
    );
    expect(accepted.event.action).toBeUndefined();
  });

  it("runs onInvalid with the error and the body before answering", async () => {
    const seen: unknown[] = [];
    const parsed = await parseJsonBody(
      post(JSON.stringify({ count: "x" })),
      schema,
      {
        onInvalid: (error, body) => {
          seen.push(error.issues.length, body);
        },
      },
    );
    expect(parsed.ok).toBe(false);
    expect(seen).toEqual([2, { count: "x" }]);
  });
});
