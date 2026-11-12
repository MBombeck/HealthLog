/**
 * Unit tests for the typed client-side API fetch wrapper.
 *
 * The wrapper owns the `.ok` check, the `{ data, error, meta? }`
 * envelope unwrap, and the `ApiError` shape (message via `readError`,
 * `status`, error-side `meta`). These tests pin that contract against a
 * mocked global `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiDelete,
  apiFetch,
  apiFetchEnvelope,
  apiFetchRaw,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "../api-fetch";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

/** The record-session assertion the transport attached to a `fetch` call. */
function recordFenceHeadersOf(call: unknown[]): {
  epoch: string | null;
  scope: string | null;
} {
  const headers = new Headers((call[1] as RequestInit | undefined)?.headers);
  return {
    epoch: headers.get("x-healthlog-record-epoch"),
    scope: headers.get("x-healthlog-record-scope"),
  };
}

describe("apiFetch", () => {
  it("unwraps the data payload from the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { id: "m1" }, error: null }),
    );

    const data = await apiFetch<{ id: string }>("/api/measurements/m1");

    expect(data).toEqual({ id: "m1" });
    // v1.37.0 — `headers` is now always present: the transport attaches the
    // record-session assertion to every same-origin request, so no call site
    // has to classify itself as record traffic. `objectContaining` rather than
    // an exact object so the assertion stays about what THIS test is for.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/measurements/m1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(recordFenceHeadersOf(fetchMock.mock.calls[0])).toEqual({
      epoch: "bootstrap",
      scope: "bootstrap",
    });
  });

  it("passes init through to fetch (signal, cache, headers)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));
    const controller = new AbortController();

    await apiFetch("/api/version", {
      cache: "no-store",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({
        cache: "no-store",
        signal: controller.signal,
      }),
    );
  });

  it("resolves undefined for a 204 response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/foo")).resolves.toBeUndefined();
  });

  it("resolves undefined for an empty 200 body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await expect(apiFetch("/api/foo")).resolves.toBeUndefined();
  });

  it("throws ApiError with the envelope error message and status", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, error: "Not found" }, 404),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Not found");
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).meta).toBeUndefined();
  });

  it("carries the error envelope meta (e.g. errorCode)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { data: null, error: "Boom", meta: { errorCode: "rate_limited" } },
        429,
      ),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).meta).toEqual({ errorCode: "rate_limited" });
  });

  it("falls back to a stable message for a non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>upstream</html>", { status: 502 }),
    );

    const err = await apiFetch("/api/foo").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("Request failed (502)");
    expect((err as ApiError).status).toBe(502);
  });

  it("does not special-case 401/403 — same ApiError, no side effect", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: "Unauthorized" }, status),
      );
      const err = await apiFetch("/api/foo").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
    }
  });

  it("lets network failures reject with the native error", async () => {
    const netErr = new TypeError("fetch failed");
    fetchMock.mockRejectedValueOnce(netErr);

    await expect(apiFetch("/api/foo")).rejects.toBe(netErr);
  });
});

describe("apiFetchEnvelope", () => {
  it("returns data and meta", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [1, 2], error: null, meta: { total: 7 } }),
    );

    const { data, meta } = await apiFetchEnvelope<number[], { total: number }>(
      "/api/items",
    );

    expect(data).toEqual([1, 2]);
    expect(meta).toEqual({ total: 7 });
  });

  it("throws ApiError on non-OK like apiFetch", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, error: "Nope" }, 422),
    );

    await expect(apiFetchEnvelope("/api/items")).rejects.toMatchObject({
      name: "ApiError",
      message: "Nope",
      status: 422,
    });
  });
});

describe("ApiError.issuePaths", () => {
  it("names the fields a 422's issue list refused", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          data: null,
          error: "Validation failed",
          details: {
            issues: [
              { path: "value", code: "custom", message: "out of range" },
            ],
          },
        },
        422,
      ),
    );
    const error = await apiPut("/api/measurements/m1", { value: 720 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).issuePaths).toEqual(["value"]);
  });

  it("is empty when the refusal named no field", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: null, error: "Nope" }, 409),
    );
    const error = await apiGet("/api/x").catch((e: unknown) => e);
    expect((error as ApiError).issuePaths).toEqual([]);
  });
});

describe("apiFetchRaw", () => {
  it("returns the raw Response without ok-check or unwrap", async () => {
    const res = new Response("plain", { status: 500 });
    fetchMock.mockResolvedValueOnce(res);

    await expect(apiFetchRaw("/api/foo")).resolves.toBe(res);
  });

  it("applies NO default timeout — SSE streams outlive any fixed window", async () => {
    fetchMock.mockResolvedValueOnce(new Response("stream", { status: 200 }));

    await apiFetchRaw("/api/insights/chat", { method: "POST" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });
});

describe("default timeout", () => {
  it("attaches a default AbortSignal when the caller passes no signal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiFetch("/api/foo", { cache: "no-store" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("a caller-supplied signal replaces the default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));
    const controller = new AbortController();

    await apiFetch("/api/foo", { signal: controller.signal });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("signal: null opts out of the default entirely", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiFetch("/api/foo", { signal: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeNull();
  });

  it("apiFetchEnvelope carries the same default", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [], error: null, meta: {} }),
    );

    await apiFetchEnvelope("/api/items");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("the default signal carries through the verb helpers' body merge", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost("/api/foo", { a: 1 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("verb helpers", () => {
  it("apiGet sets the method", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: 1, error: null }));

    await apiGet("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/foo",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    ["apiPost", apiPost, "POST"],
    ["apiPut", apiPut, "PUT"],
    ["apiPatch", apiPatch, "PATCH"],
    ["apiDelete", apiDelete, "DELETE"],
  ] as const)("%s JSON-encodes the body", async (_name, helper, method) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await helper("/api/foo", { a: 1 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/foo");
    expect(init.method).toBe(method);
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("omits body and Content-Type when no body is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost("/api/foo");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/foo",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    // Still no body and no Content-Type — the fence headers are the only ones.
    const [, bodylessInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(bodylessInit.body).toBeUndefined();
    expect(new Headers(bodylessInit.headers).get("Content-Type")).toBeNull();
  });

  // Watched red: with the `withDefaultIdempotencyKey` wrap removed from
  // apiPost/apiPatch the first two tests fail with a null header — the
  // pre-fix client sent no key, so a transport-level replay of a create
  // could land a duplicate row on every unwrapped write surface.
  describe("default Idempotency-Key", () => {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it.each([
      ["apiPost", apiPost],
      ["apiPatch", apiPatch],
    ] as const)("%s mints a per-call UUID key", async (_name, helper) => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: null }),
      );
      await helper("/api/foo", { a: 1 });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(UUID_RE);
    });

    it("a caller-supplied key wins", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: null }),
      );
      await apiPost(
        "/api/foo",
        { a: 1 },
        { headers: { "Idempotency-Key": "natural-key-1" } },
      );
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
        "natural-key-1",
      );
    });

    it("reads mint no key", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: null, error: null }),
      );
      await apiGet("/api/foo");
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
    });
  });

  it("merges caller headers with the JSON Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost("/api/foo", { a: 1 }, { headers: { "X-Req": "1" } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Req")).toBe("1");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("keeps caller headers passed as a Headers instance (no spread loss)", async () => {
    // A `Headers` instance has no enumerable own properties, so the
    // previous `{ ...init.headers }` merge silently dropped every
    // caller header for this `HeadersInit` shape.
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost(
      "/api/foo",
      { a: 1 },
      { headers: new Headers({ "X-Req": "1", "Idempotency-Key": "k1" }) },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Req")).toBe("1");
    expect(headers.get("Idempotency-Key")).toBe("k1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("respects a caller-supplied Content-Type override", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null, error: null }));

    await apiPost(
      "/api/foo",
      { a: 1 },
      {
        headers: new Headers({ "Content-Type": "application/json-patch+json" }),
      },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json-patch+json",
    );
  });
});

describe("ApiError.requestId", () => {
  it("takes meta.requestId, else the x-request-id header", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { data: null, error: "boom", meta: { requestId: "meta-id-0001" } },
        500,
      ),
    );
    const fromMeta = await apiGet("/api/x").catch((e: unknown) => e);
    expect(fromMeta).toBeInstanceOf(ApiError);
    expect((fromMeta as ApiError).requestId).toBe("meta-id-0001");

    fetchMock.mockResolvedValueOnce(
      new Response("Bad gateway", {
        status: 502,
        headers: { "x-request-id": "header-id-0001" },
      }),
    );
    const fromHeader = await apiGet("/api/x").catch((e: unknown) => e);
    expect((fromHeader as ApiError).requestId).toBe("header-id-0001");

    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const none = await apiGet("/api/x").catch((e: unknown) => e);
    expect((none as ApiError).requestId).toBeNull();
  });

  it("records a server failure's id for the session's support info", async () => {
    const { recentErrorIds, _resetRecentErrorIdsForTests } =
      await import("@/lib/errors/error-id");
    _resetRecentErrorIdsForTests();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { data: null, error: "boom", meta: { requestId: "srv-fail-0001" } },
        503,
      ),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { data: null, error: "no", meta: { requestId: "client-0001" } },
        404,
      ),
    );
    await apiGet("/api/x").catch(() => {});
    await apiGet("/api/x").catch(() => {});
    expect(recentErrorIds()).toEqual(["srv-fail-0001"]);
  });
});
