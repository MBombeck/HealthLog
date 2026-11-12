/**
 * The Web Push card with a subscription the browser already holds.
 *
 * The card reads its state from the browser alone. When the server row was
 * lost, or the channel had been switched off by failed sends, the card said
 * "enabled" and no reminder came; opening it now sends the subscription
 * again, which stores the row and turns the channel back on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { stubFetch } from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";

import { WebPushCard } from "../web-push-card";

const SUBSCRIPTION = {
  endpoint: "https://push.example.test/send/abc",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

function holdSubscription(): void {
  const subscription = { toJSON: () => SUBSCRIPTION };
  // Headless Chromium answers "denied" without a prompt.
  vi.spyOn(Notification, "permission", "get").mockReturnValue("granted");
  vi.spyOn(navigator.serviceWorker, "getRegistration").mockResolvedValue({
    pushManager: { getSubscription: async () => subscription },
  } as unknown as ServiceWorkerRegistration);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebPushCard", () => {
  it("sends the browser's existing subscription to the server when it opens", async () => {
    holdSubscription();
    const api = stubFetch().on("POST", "/api/notifications/web-push", {
      data: { subscribed: true },
    });

    const { screen } = await renderWithApp(<WebPushCard />);

    await expect
      .poll(() => api.calls("POST", "/api/notifications/web-push").length)
      .toBe(1);
    expect(api.calls("POST", "/api/notifications/web-push")[0].body).toEqual(
      SUBSCRIPTION,
    );
    await expect.element(screen.getByText("Disable push")).toBeVisible();
  });

  it("keeps showing push as on when that request fails", async () => {
    holdSubscription();
    stubFetch().on("POST", "/api/notifications/web-push", {
      status: 403,
      error: "Demo mode: modifications are disabled",
    });

    const { screen } = await renderWithApp(<WebPushCard />);

    await expect.element(screen.getByText("Disable push")).toBeVisible();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
