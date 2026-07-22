import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: vi.fn(),
}));

import { apiFetchRaw } from "@/lib/api/api-fetch";
import {
  optimisticallySetChannelEnabled,
  persistChannelEnabled,
  rollbackChannelEnabled,
} from "../notification-channel-toggle";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notification channel enable-only mutation", () => {
  it.each([
    "/api/settings/webhook",
    "/api/settings/ntfy",
    "/api/settings/email",
    "/api/settings/telegram",
  ])("sends only enabled to %s", async (endpoint) => {
    vi.mocked(apiFetchRaw).mockResolvedValue(
      new Response(JSON.stringify({ data: { saved: true } }), { status: 200 }),
    );

    await persistChannelEnabled(endpoint, true, "save failed");

    expect(apiFetchRaw).toHaveBeenCalledWith(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(
      JSON.parse(vi.mocked(apiFetchRaw).mock.calls[0]![1]!.body as string),
    ).toEqual({ enabled: true });
  });

  it("changes only cached enabled state and leaves configuration fields intact", () => {
    const client = new QueryClient();
    const key = ["settings", "webhook"] as const;
    const settings = {
      enabled: false,
      url: "https://saved.example/hook",
      topic: "saved-topic",
      recipient: "saved@example.com",
      hasHeaderValue: true,
    };
    client.setQueryData(key, settings);

    const previous = optimisticallySetChannelEnabled(client, key, true);

    expect(previous).toEqual(settings);
    expect(client.getQueryData(key)).toEqual({ ...settings, enabled: true });
  });

  it("restores the exact previous cached settings after a failed toggle", () => {
    const client = new QueryClient();
    const key = ["settings", "telegram"] as const;
    const previousSettings = {
      enabled: false,
      hasBotToken: true,
      chatId: "123456",
    };
    client.setQueryData(key, previousSettings);

    const previous = optimisticallySetChannelEnabled(client, key, true);
    expect(client.getQueryData<{ enabled: boolean }>(key)?.enabled).toBe(true);

    rollbackChannelEnabled(client, key, previous);

    expect(client.getQueryData(key)).toEqual(previousSettings);
    expect(client.getQueryData<{ enabled: boolean }>(key)?.enabled).toBe(false);
  });

  it("surfaces the route error so the card mutation can roll back", async () => {
    vi.mocked(apiFetchRaw).mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Stored configuration is missing" }),
        {
          status: 422,
        },
      ),
    );

    await expect(
      persistChannelEnabled("/api/settings/ntfy", true, "save failed"),
    ).rejects.toThrow("Stored configuration is missing");
  });
});
