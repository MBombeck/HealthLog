import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 phase B2 — AI provider settings UX with single dropdown
 * driving the form below. Three things to lock in here:
 *
 *   1. /settings/ai exposes the active-provider Pulldown
 *      (`data-testid="ai-active-provider-select"`).
 *   2. Switching the dropdown changes the rendered config form below
 *      it: Codex form vs. OpenAI form vs. Anthropic form vs. Local
 *      form. Each form carries a stable `data-testid` so we don't
 *      lean on i18n labels.
 *   3. The fallback chain card surfaces with stable
 *      `data-chain-row="<providerType>"` markers per row.
 */
test.describe("Settings → AI provider dropdown UX (B2)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("dropdown switch changes the rendered config form", async ({ page }) => {
    // Stable mocks for every endpoint the section reads. The chain
    // mirrors the default order (codex first) so the rows render
    // deterministically and the dropdown defaults to codex.
    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: "disconnected",
            codexConnectedAt: null,
            hasAdminKey: false,
            codexOauthConfigured: true,
            privacyMode: "aggregated",
            lastInsightAt: null,
          },
          error: null,
        }),
      }),
    );

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

    await page.route("**/api/insights/provider-chain", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            activeProvider: "codex",
            cachedActiveProvider: null,
            configuredChain: [
              { providerType: "codex", available: true },
              { providerType: "openai", available: true },
              { providerType: "anthropic", available: true },
              { providerType: "local", available: true },
            ],
          },
          error: null,
        }),
      }),
    );

    // Hydration gate — the provider query is fired by the same client
    // boundary that renders the select, so its response proves React
    // has hydrated the card and attached the select's change handler.
    // `selectOption` on the SSR-painted element any earlier flips the
    // native value without React noticing, and the config form below
    // never switches (CI failure at slow hydration).
    const cardHydrated = page.waitForResponse("**/api/user/ai-provider");
    await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });
    await cardHydrated;

    // 1. Dropdown surfaces on the page.
    const select = page.getByTestId("ai-active-provider-select");
    await expect(select).toBeVisible({ timeout: 10_000 });

    // 2a. Default → Codex form rendered.
    await expect(page.getByTestId("ai-provider-config-codex")).toBeVisible();
    await expect(page.getByTestId("ai-provider-config-openai")).toHaveCount(0);

    // 2b. Switch to OpenAI → OpenAI form rendered, Codex form gone.
    await select.selectOption("openai");
    await expect(page.getByTestId("ai-provider-config-openai")).toBeVisible();
    await expect(page.getByTestId("ai-provider-config-codex")).toHaveCount(0);
    await expect(page.getByTestId("ai-openai-api-key")).toBeVisible();
    await expect(page.getByTestId("ai-openai-model")).toBeVisible();

    // 2c. Switch to Anthropic → Anthropic form rendered.
    await select.selectOption("anthropic");
    await expect(
      page.getByTestId("ai-provider-config-anthropic"),
    ).toBeVisible();

    // 2d. Switch to Local → Local form rendered.
    await select.selectOption("local");
    await expect(page.getByTestId("ai-provider-config-local")).toBeVisible();

    // 3. Fallback chain card surfaces with the four chain rows.
    await expect(page.getByTestId("ai-fallback-chain")).toBeVisible();
    for (const slug of ["codex", "openai", "anthropic", "local"]) {
      await expect(page.locator(`[data-chain-row="${slug}"]`)).toBeVisible();
    }
  });
  test("provider editors submit once by Enter or click and isolate connection tests", async ({
    page,
  }) => {
    const patchBodies: Array<Record<string, unknown>> = [];
    let releasePendingPatch: () => void = () => undefined;
    let holdNextPatch = false;
    let testConnectionRequests = 0;
    let providerState: Record<string, unknown> = {
      provider: null,
      model: null,
      baseUrl: null,
      responseTimeoutSeconds: null,
      hasAnthropicKey: false,
      anthropicKeyPreview: null,
      hasLocalKey: false,
      hasOpenaiKey: false,
      openaiKeyPreview: null,
    };

    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: "disconnected",
            codexConnectedAt: null,
            hasAdminKey: false,
            codexOauthConfigured: true,
            privacyMode: "aggregated",
            lastInsightAt: null,
          },
          error: null,
        }),
      }),
    );
    await page.route("**/api/user/ai-provider", async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        patchBodies.push(body);
        providerState = { ...providerState, ...body };
        if (holdNextPatch) {
          holdNextPatch = false;
          await new Promise<void>((resolve) => {
            releasePendingPatch = resolve;
          });
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: providerState, error: null }),
      });
    });
    await page.route("**/api/insights/provider-chain", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            activeProvider: "codex",
            cachedActiveProvider: null,
            configuredChain: [
              { providerType: "codex", available: true },
              { providerType: "openai", available: true },
              { providerType: "anthropic", available: true },
              { providerType: "local", available: true },
            ],
          },
          error: null,
        }),
      }),
    );
    await page.route("**/api/ai/test", (route) => {
      testConnectionRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ok: true, providerType: "local", model: "test-model" },
          error: null,
        }),
      });
    });

    const providerHydrated = page.waitForResponse("**/api/user/ai-provider");
    await page.goto("/settings/ai?provider=openai", {
      waitUntil: "domcontentloaded",
    });
    await providerHydrated;

    const select = page.getByTestId("ai-active-provider-select");

    async function assertEnterAndClickSubmitOnce({
      provider,
      formTestId,
      inputId,
      enterValue,
      clickValue,
      expectedField,
    }: {
      provider: "openai" | "anthropic" | "local";
      formTestId: string;
      inputId: string;
      enterValue: string;
      clickValue: string;
      expectedField: string;
    }) {
      await select.selectOption(provider);
      const form = page.getByTestId(formTestId);
      await expect(form).toHaveJSProperty("tagName", "FORM");
      const input = page.locator(`#${inputId}`);
      const save = form.locator('button[type="submit"]');
      await expect(save).toHaveCount(1);

      await input.fill(enterValue);
      const enterBaseline = patchBodies.length;
      await input.press("Enter");
      await expect.poll(() => patchBodies.length).toBe(enterBaseline + 1);
      await page.waitForTimeout(50);
      expect(patchBodies).toHaveLength(enterBaseline + 1);
      expect(patchBodies.at(-1)?.[expectedField]).toBe(enterValue);

      await input.fill(clickValue);
      const clickBaseline = patchBodies.length;
      await save.click();
      await expect.poll(() => patchBodies.length).toBe(clickBaseline + 1);
      await page.waitForTimeout(50);
      expect(patchBodies).toHaveLength(clickBaseline + 1);
      expect(patchBodies.at(-1)?.[expectedField]).toBe(clickValue);
    }

    await assertEnterAndClickSubmitOnce({
      provider: "openai",
      formTestId: "ai-provider-config-openai",
      inputId: "ai-openai-key",
      enterValue: "sk-enter-openai",
      clickValue: "sk-click-openai",
      expectedField: "openaiKey",
    });
    await assertEnterAndClickSubmitOnce({
      provider: "anthropic",
      formTestId: "ai-provider-config-anthropic",
      inputId: "ai-anthropic-key",
      enterValue: "sk-ant-enter",
      clickValue: "sk-ant-click",
      expectedField: "anthropicKey",
    });
    await assertEnterAndClickSubmitOnce({
      provider: "local",
      formTestId: "ai-provider-config-local",
      inputId: "ai-local-base-url",
      enterValue: "http://localhost:11434/v1",
      clickValue: "http://localhost:11435/v1",
      expectedField: "baseUrl",
    });

    const timeoutForm = page.locator("form").filter({
      has: page.locator("#ai-response-timeout"),
    });
    const timeoutInput = page.locator("#ai-response-timeout");
    const timeoutSave = timeoutForm.locator('button[type="submit"]');
    await expect(timeoutForm).toHaveCount(1);
    await expect(timeoutSave).toHaveCount(1);

    await timeoutInput.fill("9");
    const invalidTimeoutBaseline = patchBodies.length;
    await timeoutInput.press("Enter");
    await expect(timeoutForm.locator("p.text-destructive")).toBeVisible();
    expect(patchBodies).toHaveLength(invalidTimeoutBaseline);

    await timeoutInput.fill("180");
    const timeoutEnterBaseline = patchBodies.length;
    await timeoutInput.press("Enter");
    await expect.poll(() => patchBodies.length).toBe(timeoutEnterBaseline + 1);
    await page.waitForTimeout(50);
    expect(patchBodies).toHaveLength(timeoutEnterBaseline + 1);
    expect(patchBodies.at(-1)?.responseTimeoutSeconds).toBe(180);

    await timeoutInput.fill("240");
    const timeoutClickBaseline = patchBodies.length;
    await timeoutSave.click();
    await expect.poll(() => patchBodies.length).toBe(timeoutClickBaseline + 1);
    await page.waitForTimeout(50);
    expect(patchBodies).toHaveLength(timeoutClickBaseline + 1);
    expect(patchBodies.at(-1)?.responseTimeoutSeconds).toBe(240);

    holdNextPatch = true;
    await page.locator("#ai-local-base-url").fill("http://localhost:11436/v1");
    const pendingBaseline = patchBodies.length;
    await page
      .getByTestId("ai-provider-config-local")
      .evaluate((form: HTMLFormElement) => {
        form.requestSubmit();
        form.requestSubmit();
      });
    await expect.poll(() => patchBodies.length).toBe(pendingBaseline + 1);
    await expect(
      page
        .getByTestId("ai-provider-config-local")
        .locator('button[type="submit"]'),
    ).toBeDisabled();
    await page.waitForTimeout(50);
    expect(patchBodies).toHaveLength(pendingBaseline + 1);

    const testConnection = page.getByTestId("ai-test-active-provider");
    await expect(testConnection).toHaveAttribute("type", "button");
    await testConnection.click();
    await expect.poll(() => testConnectionRequests).toBe(1);
    expect(patchBodies).toHaveLength(pendingBaseline + 1);

    releasePendingPatch();
    await expect(
      page
        .getByTestId("ai-provider-config-local")
        .locator('button[type="submit"]'),
    ).toBeEnabled();
  });
});
