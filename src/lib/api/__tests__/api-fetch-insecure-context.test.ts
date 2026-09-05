/**
 * Every client write still works on a plain-HTTP origin.
 *
 * `apiPost` / `apiPatch` mint a default `Idempotency-Key`. That key came
 * from `crypto.randomUUID()`, which the Web Cryptography IDL marks
 * `[SecureContext]` — absent on `http://<lan-ip>`, verified in Chromium.
 * So on a LAN self-host served over plain HTTP the header line threw
 * before `fetch` was ever reached, and all seventy-odd `apiPost` /
 * `apiPatch` call sites failed with a raw TypeError.
 *
 * Watched red: restoring `crypto.randomUUID()` in
 * `withDefaultIdempotencyKey` fails every case here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const fetchMock = vi.fn();

/**
 * Bound BEFORE any stubbing: `vi.stubGlobal("crypto", …)` replaces
 * `globalThis.crypto`, so a stub that delegated through the global would
 * call itself.
 */
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(
  globalThis.crypto,
);

/**
 * The `crypto` a plain-HTTP origin actually hands the page: real
 * `getRandomValues`, no `randomUUID`, no `subtle`.
 */
function insecureCrypto(): Crypto {
  return { getRandomValues: realGetRandomValues } as Crypto;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function idempotencyKeyOf(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get(
    "Idempotency-Key",
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", insecureCrypto());
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("client writes on a plain-HTTP origin", () => {
  it("has no crypto.randomUUID to call — the control", () => {
    expect(typeof (crypto as Crypto).randomUUID).toBe("undefined");
  });

  it("apiPost still sends, with a v4 Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: "m1" } }));
    const { apiPost } = await import("../api-fetch");

    await expect(apiPost("/api/measurements", { value: 80 })).resolves.toEqual({
      id: "m1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(idempotencyKeyOf(fetchMock.mock.calls[0]!)).toMatch(UUID_V4);
  });

  it("apiPatch still sends, with a v4 Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const { apiPatch } = await import("../api-fetch");

    await apiPatch("/api/auth/me", { locale: "de" });

    expect(idempotencyKeyOf(fetchMock.mock.calls[0]!)).toMatch(UUID_V4);
  });

  it("gives each write its own key", async () => {
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse({ data: null }));
    const { apiPost } = await import("../api-fetch");

    await apiPost("/api/measurements", { value: 80 });
    await apiPost("/api/measurements", { value: 81 });

    const first = idempotencyKeyOf(fetchMock.mock.calls[0]!);
    const second = idempotencyKeyOf(fetchMock.mock.calls[1]!);
    expect(first).not.toBe(second);
  });

  it("still lets a caller's own natural key win", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: null }));
    const { apiPost } = await import("../api-fetch");

    await apiPost(
      "/api/admin/backups/b1/restore",
      { confirm: "RESTORE" },
      { headers: { "Idempotency-Key": "restore-b1-fixed" } },
    );

    expect(idempotencyKeyOf(fetchMock.mock.calls[0]!)).toBe("restore-b1-fixed");
  });
});
