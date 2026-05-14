import { describe, expect, it } from "vitest";

import { readError } from "../read-error";

function makeResponse(body: unknown, status: number, opts?: { invalidJson?: boolean }): Response {
  if (opts?.invalidJson) {
    return new Response("<<not json>>", {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readError", () => {
  it("returns the server-supplied error string when present", async () => {
    const res = makeResponse({ data: null, error: "Goal limit reached" }, 422);
    expect(await readError(res)).toBe("Goal limit reached");
  });

  it("falls back to status-coded fallback when the envelope omits error", async () => {
    const res = makeResponse({ data: null }, 500);
    expect(await readError(res)).toBe("Request failed (500)");
  });

  it("falls back when the error field is empty", async () => {
    const res = makeResponse({ data: null, error: "" }, 400);
    expect(await readError(res)).toBe("Request failed (400)");
  });

  it("falls back when the JSON body fails to parse", async () => {
    const res = makeResponse(null, 503, { invalidJson: true });
    expect(await readError(res)).toBe("Request failed (503)");
  });

  it("falls back when the error field is the wrong type", async () => {
    const res = makeResponse({ data: null, error: 42 }, 400);
    expect(await readError(res)).toBe("Request failed (400)");
  });

  it("never throws even when the response body is empty", async () => {
    const res = new Response(null, { status: 502 });
    expect(await readError(res)).toBe("Request failed (502)");
  });
});
