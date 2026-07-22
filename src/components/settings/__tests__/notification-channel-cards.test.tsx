import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutationOptions: [] as Array<{
    mutationFn: (enabled: boolean) => Promise<void>;
    onMutate?: (enabled: boolean) => Promise<unknown>;
    onError?: (error: Error, enabled: boolean, previous: unknown) => void;
  }>,
  apiFetchRaw: vi.fn(),
  queryClient: {
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    const key = queryKey.join("/");
    if (key === "settings/webhook") {
      return {
        data: {
          enabled: false,
          url: "https://saved.example/hook",
          headerName: "Authorization",
          hasHeaderValue: true,
        },
      };
    }
    if (key === "settings/ntfy") {
      return {
        data: {
          enabled: false,
          serverUrl: "https://ntfy.sh",
          topic: "saved-topic",
          hasAuthToken: true,
        },
      };
    }
    if (key === "settings/email") {
      return {
        data: {
          enabled: false,
          recipient: "saved@example.com",
          smtpConfigured: true,
        },
      };
    }
    return {
      data: { enabled: false, hasBotToken: true, chatId: "saved-chat" },
    };
  },
  useMutation: (options: {
    mutationFn: (enabled: boolean) => Promise<void>;
    onMutate?: (enabled: boolean) => Promise<unknown>;
    onError?: (error: Error, enabled: boolean, previous: unknown) => void;
  }) => {
    mocks.mutationOptions.push(options);
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: mocks.apiFetchRaw,
  apiGet: vi.fn(),
}));

vi.mock("../test-connection-button", () => ({
  TestConnectionButton: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { WebhookCard } from "../webhook-card";
import { NtfyCard } from "../ntfy-card";
import { EmailCard } from "../email-card";
import { TelegramCard } from "../telegram-card";

function render(card: ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{card}</I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutationOptions.length = 0;
  mocks.queryClient.cancelQueries.mockResolvedValue(undefined);
  mocks.apiFetchRaw.mockResolvedValue(
    new Response(JSON.stringify({ data: { saved: true }, error: null }), {
      status: 200,
    }),
  );
});

describe("notification channel cards", () => {
  it.each([
    ["webhook", <WebhookCard key="webhook" isAuthenticated />, 1],
    ["ntfy", <NtfyCard key="ntfy" isAuthenticated />, 1],
    ["email", <EmailCard key="email" isAuthenticated />, 1],
    ["telegram", <TelegramCard key="telegram" isAuthenticated />, 0],
  ] as const)(
    "%s switch invokes the enable-only mutation rather than the full save",
    async (channel, card, toggleMutationIndex) => {
      render(card);

      await mocks.mutationOptions[toggleMutationIndex]!.mutationFn(true);

      expect(mocks.apiFetchRaw).toHaveBeenCalledTimes(1);
      expect(mocks.apiFetchRaw).toHaveBeenCalledWith(
        `/api/settings/${channel}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
    },
  );

  it.each([
    [<WebhookCard key="webhook" isAuthenticated />, 1, ["settings", "webhook"]],
    [<NtfyCard key="ntfy" isAuthenticated />, 1, ["settings", "ntfy"]],
    [<EmailCard key="email" isAuthenticated />, 1, ["settings", "email"]],
    [
      <TelegramCard key="telegram" isAuthenticated />,
      0,
      ["telegram", "settings"],
    ],
  ] as const)(
    "rolls each visible switch back to its previous server state on error",
    async (card, toggleMutationIndex, queryKey) => {
      const previous = { enabled: false, persistedConfig: "unchanged" };
      mocks.queryClient.getQueryData.mockReturnValue(previous);
      render(card);
      const toggle = mocks.mutationOptions[toggleMutationIndex]!;

      const context = await toggle.onMutate!(true);
      const optimisticUpdater = mocks.queryClient.setQueryData.mock
        .calls[0]![1] as (current: typeof previous) => typeof previous;
      expect(optimisticUpdater(previous)).toEqual({
        ...previous,
        enabled: true,
      });

      toggle.onError!(new Error("save failed"), true, context);

      expect(mocks.queryClient.setQueryData).toHaveBeenLastCalledWith(
        queryKey,
        previous,
      );
    },
  );
});
