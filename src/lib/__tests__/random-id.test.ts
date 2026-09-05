/**
 * `randomId()` under both context shapes a browser can present.
 *
 * The insecure shape is not invented for the test. Measured in Chromium on
 * `http://<lan-ip>` — a plain-HTTP LAN self-host, the reporter's setup:
 *
 *   isSecureContext        false
 *   crypto                 object
 *   crypto.randomUUID      undefined  → "TypeError: … is not a function"
 *   crypto.subtle          undefined
 *   crypto.getRandomValues function
 *
 * `insecureCrypto()` reproduces exactly that: `getRandomValues` present,
 * `randomUUID` and `subtle` absent.
 *
 * Watched red: with the fallback branch removed — `randomId` reduced to a
 * bare `return crypto.randomUUID()` — every insecure-context case below
 * fails with the same TypeError the plain-HTTP host raises.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Fresh import per case — the module must not cache a context decision. */
async function loadRandomId() {
  vi.resetModules();
  return (await import("../random-id")).randomId;
}

describe("randomId in a secure context", () => {
  it("delegates to the platform randomUUID", async () => {
    const randomUUID = vi.fn(
      () => "11111111-2222-4333-8444-555555555555" as const,
    );
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID });

    const randomId = await loadRandomId();

    expect(randomId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });
});

describe("randomId on a plain-HTTP origin", () => {
  it("returns a v4 UUID without randomUUID present", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const randomId = await loadRandomId();

    expect(randomId()).toMatch(UUID_V4);
  });

  it("does not throw where crypto.randomUUID would", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const randomId = await loadRandomId();

    // The control: the call the app used to make is genuinely unavailable.
    expect(() => (crypto as Crypto).randomUUID()).toThrow(TypeError);
    expect(() => randomId()).not.toThrow();
  });

  it("draws from getRandomValues, not a clock or Math.random", async () => {
    const getRandomValues = vi.fn(realGetRandomValues);
    vi.stubGlobal("crypto", { getRandomValues } as unknown as Crypto);
    const randomId = await loadRandomId();

    randomId();

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(getRandomValues.mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
  });

  it("does not collide across a batch the size of a bulk upload", async () => {
    vi.stubGlobal("crypto", insecureCrypto());
    const randomId = await loadRandomId();

    const ids = new Set(Array.from({ length: 5_000 }, () => randomId()));

    expect(ids.size).toBe(5_000);
  });
});
