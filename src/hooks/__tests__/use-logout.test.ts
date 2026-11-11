/**
 * Signing out: what the browser is left with when the server answers.
 *
 * `useMutation` is replaced by a stand-in that hands back the options, so the
 * test drives `mutationFn`, `onSuccess` and `onError` the way React Query
 * does, against the real fetch wrapper and a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface LogoutOptions {
  mutationFn: () => Promise<void>;
  onSuccess: () => void;
  onError: (failure: unknown) => void;
}

const captured: { options: LogoutOptions | null } = { options: null };
const push = vi.fn();
const clear = vi.fn();
const showErrorToast = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useQueryClient: () => ({ clear }),
  useMutation: (options: LogoutOptions) => {
    captured.options = options;
    return { mutate: vi.fn(), isPending: false };
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/errors/error-toast", () => ({
  showErrorToast: (...args: unknown[]) => showErrorToast(...args),
}));
vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: vi.fn().mockResolvedValue(undefined),
}));

import { useLogout } from "../use-auth";

const fetchMock =
  vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What React Query does with the options: run, then settle one way. */
async function settle(options: LogoutOptions): Promise<void> {
  try {
    await options.mutationFn();
  } catch (failure) {
    options.onError(failure);
    return;
  }
  options.onSuccess();
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  captured.options = null;
});

describe("useLogout", () => {
  it("clears the caches and opens the sign-in page once the server signed out", async () => {
    fetchMock.mockResolvedValue(json(200, { data: { loggedOut: true } }));

    useLogout();
    await settle(captured.options!);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/auth/login");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("stays on the page and says so when the server refuses", async () => {
    // The demo instance answered 403 here; the page showed the sign-in form
    // while the session cookie still opened every record page.
    fetchMock.mockResolvedValue(json(403, { data: null, error: "Forbidden" }));

    useLogout();
    await settle(captured.options!);

    expect(push).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(
      "auth.signOutFailed",
      expect.objectContaining({ cause: expect.anything() }),
    );
  });
});
