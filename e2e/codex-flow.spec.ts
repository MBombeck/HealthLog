import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Settings → KI Codex device-flow spec. The real OAuth handshake bounces
 * through chatgpt.com, which we deliberately do NOT hit from CI; instead
 * we mock the three relevant endpoints (`device-start`, `device-poll`,
 * `insights/settings`) so the assertion focuses on the UI state machine:
 *
 *   1. "Connect with ChatGPT" CTA visible
 *   2. After click → device-code panel showing userCode + verificationUrl
 *   3. After mocked poll flips to `connected` → "ChatGPT connected" badge
 */
test.describe("settings AI codex device flow (mocked)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("button → device-code panel → connected state", async ({ page }) => {
    let connected = false;

    // Status endpoint — flips to "connected" once `connected` is set.
    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: connected ? "connected" : "disconnected",
            codexConnectedAt: connected ? new Date().toISOString() : null,
            hasAdminKey: false,
            codexOauthConfigured: true,
            privacyMode: "aggregated",
            lastInsightAt: null,
          },
          error: null,
        }),
      }),
    );

    // device-start — returns the user-facing code + verification URL.
    await page.route("**/api/auth/codex/device-start", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            userCode: "WXYZ-7890",
            verificationUrl: "https://chatgpt.com/codex/device",
            intervalSeconds: 1,
          },
          error: null,
        }),
      }),
    );

    // device-poll — first call returns `pending`; flips to `connected`
    // after a short delay so the test can assert the transition.
    let pollCount = 0;
    await page.route("**/api/auth/codex/device-poll", (route) => {
      pollCount += 1;
      const status = pollCount >= 2 ? "connected" : "pending";
      if (status === "connected") connected = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { status },
          error: null,
        }),
      });
    });

    // Mock the user AI provider endpoint — the AI section renders a
    // sub-panel that fetches this; we want it to resolve quickly so the
    // page is interactive.
    await page.route("**/api/user/ai-provider", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            provider: null,
            model: null,
            baseUrl: null,
            hasAnthropicKey: false,
            anthropicKeyPreview: null,
            hasLocalKey: false,
            hasOpenaiKey: false,
            openaiKeyPreview: null,
          },
          error: null,
        }),
      }),
    );

    // Hydration gate — the settings query is fired by the same client
    // boundary that renders the Codex form, so its response proves React
    // has attached the CTA's click handler. On mobile the SSR-painted button
    // can otherwise be clicked before hydration and the event is lost.
    const codexFormHydrated = page.waitForResponse("**/api/insights/settings");

    await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });
    await codexFormHydrated;

    // Step 1 — CTA visible
    const cta = page.getByRole("button", {
      name: /connect with chatgpt|mit chatgpt verbinden/i,
    });
    await expect(cta).toBeVisible({ timeout: 10_000 });
    await cta.click();

    // Step 2 — device-code panel shows the userCode and the verificationUrl
    await expect(page.getByText("WXYZ-7890")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("link", { name: /chatgpt\.com\/codex\/device/i }),
    ).toBeVisible();

    // Step 3 — once the polling loop hits `connected`, the badge appears.
    // The poll runs at the device-flow `intervalSeconds` (1 second).
    await expect(page.getByText(/chatgpt connected/i).first()).toBeVisible({
      timeout: 15_000,
    });

    // The device-code panel should disappear once connected (the
    // settings card swaps to the connected layout).
    await expect(page.getByText("WXYZ-7890")).toBeHidden({ timeout: 5_000 });
  });
});
