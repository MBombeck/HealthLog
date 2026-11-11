/**
 * Offline auth gate — a failed `/api/auth/me` is only a session END when the
 * server said so (401/403).
 *
 * Pre-fix, ANY auth-probe error read as "logged out": an airplane-mode
 * relaunch redirected to /auth/login and `clearCachesForSessionEnd()` wiped
 * the SW data/page caches and the IndexedDB query snapshot — destroying
 * exactly the installed-PWA-opened-offline scenario the offline plumbing
 * exists for. These tests pin the classification (`isAuthVerdictUnknown`),
 * the last-known-state fallback (`readWasAuthenticated` marker), and the
 * marker's session-end lifecycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const clearOfflineCachesForSessionEnd = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: () => clearOfflineCachesForSessionEnd(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

// Drivable query state so the hook's classification can be exercised for
// success / network-error / 401 without a fetch layer.
interface MockQueryState {
  data: unknown;
  isError: boolean;
  error: unknown;
  isLoading: boolean;
}
let queryState: MockQueryState;
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: () => ({ ...queryState, refetch: vi.fn() }),
    useQueryClient: () => ({}),
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
  };
});

import { ApiError } from "@/lib/api/api-fetch";
import {
  clearCachesForSessionEnd,
  isAuthVerdictUnknown,
  readWasAuthenticated,
  useAuth,
} from "../use-auth";

// Node test env has no localStorage — back it with a Map.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  queryState = {
    data: undefined,
    isError: false,
    error: null,
    isLoading: false,
  };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearOfflineCachesForSessionEnd.mockClear();
});

describe("isAuthVerdictUnknown — failure classification", () => {
  it("treats a fetch TypeError (offline / DNS) as no verdict", () => {
    expect(isAuthVerdictUnknown(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("treats the SW's synthetic 503 offline envelope as no verdict", () => {
    expect(
      isAuthVerdictUnknown(new ApiError("offline", 503, { offline: true })),
    ).toBe(true);
  });

  it("treats an abort/timeout as no verdict", () => {
    expect(
      isAuthVerdictUnknown(new DOMException("timeout", "TimeoutError")),
    ).toBe(true);
  });

  it("treats a 5xx as no verdict — a server hiccup is not a logout", () => {
    expect(isAuthVerdictUnknown(new ApiError("boom", 500))).toBe(true);
  });

  it("treats 401 and 403 as the real session-end verdict", () => {
    expect(isAuthVerdictUnknown(new ApiError("unauthorized", 401))).toBe(false);
    expect(isAuthVerdictUnknown(new ApiError("forbidden", 403))).toBe(false);
  });
});

describe("useAuth — last-known state on a non-verdict failure", () => {
  it("stays authenticated on a network failure when a prior session marker exists", () => {
    store.set("healthlog-was-authenticated", "1");
    queryState.isError = true;
    queryState.error = new TypeError("Failed to fetch");

    const auth = useAuth();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.isAuthUnknown).toBe(true);
    expect(auth.user).toBeNull();
  });

  it("reads unauthenticated-but-unknown on a network failure without a marker", () => {
    queryState.isError = true;
    queryState.error = new TypeError("Failed to fetch");

    const auth = useAuth();
    expect(auth.isAuthenticated).toBe(false);
    // The shell must NOT run the session-end wipe off this state.
    expect(auth.isAuthUnknown).toBe(true);
  });

  it("reads a true 401 as session end — wipe and redirect may proceed", () => {
    store.set("healthlog-was-authenticated", "1");
    queryState.isError = true;
    queryState.error = new ApiError("unauthorized", 401);

    const auth = useAuth();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isAuthUnknown).toBe(false);
  });
});

describe("useAuth — a verdict on a refetch", () => {
  it("ends the session on a 401 although the cache still holds the account", () => {
    store.set("healthlog-was-authenticated", "1");
    queryState.data = { id: "u1", username: "someone" };
    queryState.isError = true;
    queryState.error = new ApiError("unauthorized", 401);

    const auth = useAuth();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.isAuthUnknown).toBe(false);
  });

  it("keeps the cached account through a network failure on a refetch", () => {
    queryState.data = { id: "u1", username: "someone" };
    queryState.isError = true;
    queryState.error = new TypeError("Failed to fetch");

    const auth = useAuth();
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.user).toEqual({ id: "u1", username: "someone" });
  });
});

describe("session-end marker lifecycle", () => {
  it("clearCachesForSessionEnd drops the marker so the next cold offline launch lands on the login gate", () => {
    store.set("healthlog-was-authenticated", "1");
    expect(readWasAuthenticated()).toBe(true);

    clearCachesForSessionEnd(new QueryClient());

    expect(readWasAuthenticated()).toBe(false);
    expect(clearOfflineCachesForSessionEnd).toHaveBeenCalledTimes(1);
  });
});
