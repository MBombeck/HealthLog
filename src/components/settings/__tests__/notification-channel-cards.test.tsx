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
  testButtonProps: [] as Array<{ endpoint: string; unsavedChanges?: boolean }>,
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

vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/api-fetch")>()),
  apiFetchRaw: mocks.apiFetchRaw,
  apiGet: vi.fn(),
}));

vi.mock("../test-connection-button", () => ({
  TestConnectionButton: (props: {
    endpoint: string;
    unsavedChanges?: boolean;
  }) => {
    mocks.testButtonProps.push(props);
    return null;
  },
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
  mocks.testButtonProps.length = 0;
  mocks.queryClient.cancelQueries.mockResolvedValue(undefined);
  mocks.apiFetchRaw.mockResolvedValue(
    new Response(JSON.stringify({ data: { saved: true }, error: null }), {
      status: 200,
    }),
  );
});

describe("notification channel cards", () => {
  it.each([
    ["webhook", <WebhookCard key="webhook" isAuthenticated />],
    ["ntfy", <NtfyCard key="ntfy" isAuthenticated />],
    ["email", <EmailCard key="email" isAuthenticated />],
    ["telegram", <TelegramCard key="telegram" isAuthenticated />],
  ] as const)(
    "%s hands its unsaved-change state to the test button, clean once seeded from the server",
    (channel, card) => {
      render(card);
      const props = mocks.testButtonProps.at(-1);
      expect(props?.endpoint).toBe(`/api/settings/${channel}/test`);
      expect(props?.unsavedChanges).toBe(false);
    },
  );

  it.each([
    ["webhook", <WebhookCard key="webhook" isAuthenticated />],
    ["ntfy", <NtfyCard key="ntfy" isAuthenticated />],
    ["email", <EmailCard key="email" isAuthenticated />],
    ["telegram", <TelegramCard key="telegram" isAuthenticated />],
  ] as const)(
    "%s enable switch saves on tap, alone, outside the form",
    async (channel, card) => {
      const html = render(card);
      // The switch precedes the form: its Save covers the fields, not the
      // switch.
      expect(html.indexOf('role="switch"')).toBeGreaterThan(-1);
      expect(html.indexOf('role="switch"')).toBeLessThan(html.indexOf("<form"));
      expect(mocks.apiFetchRaw).not.toHaveBeenCalled();

      // The card's first mutation is the switch's, and it sends `enabled`
      // and nothing else.
      await mocks.mutationOptions[0]!.mutationFn(true);
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
    [<WebhookCard key="webhook" isAuthenticated />, ["settings", "webhook"]],
    [<NtfyCard key="ntfy" isAuthenticated />, ["settings", "ntfy"]],
    [<EmailCard key="email" isAuthenticated />, ["settings", "email"]],
    [<TelegramCard key="telegram" isAuthenticated />, ["telegram", "settings"]],
  ] as const)(
    "rolls each switch back to its previous server state on error",
    async (card, queryKey) => {
      const previous = { enabled: false, persistedConfig: "unchanged" };
      mocks.queryClient.getQueryData.mockReturnValue(previous);
      render(card);
      const toggle = mocks.mutationOptions[0]!;

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

  it("webhook card offers the payload format and sends it with the full save (#947)", async () => {
    const html = render(<WebhookCard isAuthenticated />);

    expect(html).toContain('id="webhook-format"');
    expect(html).toMatch(/<option value="generic" selected="">/);
    expect(html).toContain('<option value="gotify">');

    // The full save is the mutation of the last render, whose closure holds
    // the values seeded from the server; it carries the stored enable state.
    const save = mocks.mutationOptions.at(-1)!;
    await save.mutationFn(false);

    const [, init] = mocks.apiFetchRaw.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body)).toMatchObject({
      url: "https://saved.example/hook",
      format: "generic",
      enabled: false,
    });
  });
});
