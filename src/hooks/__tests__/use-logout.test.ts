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
const replace = vi.fn();
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
  useRouter: () => ({ push: vi.fn(), replace }),
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
  it("clears the caches and replaces the page with the sign-in page once the server signed out", async () => {
    fetchMock.mockResolvedValue(json(200, { data: { loggedOut: true } }));

    useLogout();
    await settle(captured.options!);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/auth/login");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  /** A browser holding a push subscription; returns the call order log. */
  function holdSubscription(order: string[]) {
    const unsubscribe = vi.fn(async () => {
      order.push("browser unsubscribe");
      return true;
    });
    const subscription = {
      endpoint: "https://push.example.com/send/abc",
      toJSON: () => ({
        endpoint: "https://push.example.com/send/abc",
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
      unsubscribe,
    };
    vi.stubGlobal("window", { PushManager: class {} });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => ({
          pushManager: { getSubscription: async () => subscription },
        }),
      },
    });
    return { subscription, unsubscribe };
  }

  it("takes this browser's push subscription off the account and out of the browser", async () => {
    // Left in place, the browser kept showing the signed-out account's
    // medication reminders, also after someone else signed in. The server
    // row goes while the session can still name it; the browser's own only
    // once the sign-out is confirmed.
    const order: string[] = [];
    const { subscription } = holdSubscription(order);
    fetchMock.mockImplementation(async (url, init) => {
      order.push(`${init?.method} ${url}`);
      return json(200, { data: {} });
    });

    useLogout();
    await settle(captured.options!);

    expect(order).toEqual([
      "DELETE /api/notifications/web-push",
      "POST /api/auth/logout",
      "browser unsubscribe",
    ]);
    const deleteCall = fetchMock.mock.calls[0];
    expect(JSON.parse(String(deleteCall[1]?.body))).toEqual({
      endpoint: subscription.endpoint,
    });
    // A connection that carries nothing must not hold the sign-out.
    expect(deleteCall[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(replace).toHaveBeenCalledWith("/auth/login");
  });

  it("keeps push working when the server refuses the sign-out", async () => {
    const order: string[] = [];
    const { unsubscribe } = holdSubscription(order);
    fetchMock.mockImplementation(async (url, init) => {
      order.push(`${init?.method} ${url}`);
      return url === "/api/auth/logout"
        ? json(503, { data: null, error: "Unavailable" })
        : json(200, { data: {} });
    });

    useLogout();
    await settle(captured.options!);

    expect(order).toEqual([
      "DELETE /api/notifications/web-push",
      "POST /api/auth/logout",
      "POST /api/notifications/web-push",
    ]);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledTimes(1);
  });

  it("still signs out when removing the subscription fails", async () => {
    vi.stubGlobal("window", { PushManager: class {} });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: async () => {
          throw new Error("no worker");
        },
      },
    });
    fetchMock.mockResolvedValue(json(200, { data: { loggedOut: true } }));

    useLogout();
    await settle(captured.options!);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    expect(replace).toHaveBeenCalledWith("/auth/login");
  });

  it("stays on the page and says so when the server refuses", async () => {
    // The demo instance answered 403 here; the page showed the sign-in form
    // while the session cookie still opened every record page.
    fetchMock.mockResolvedValue(json(403, { data: null, error: "Forbidden" }));

    useLogout();
    await settle(captured.options!);

    expect(replace).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(showErrorToast).toHaveBeenCalledWith(
      "auth.signOutFailed",
      expect.objectContaining({ cause: expect.anything() }),
    );
  });
});
