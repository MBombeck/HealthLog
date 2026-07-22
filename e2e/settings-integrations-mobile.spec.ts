import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.19 phase A5 — `/settings/integrations` on a Pixel-5 viewport
 * (393 CSS px) must:
 *
 *   1. Not produce horizontal page overflow. The new
 *      IntegrationStatusPill is `whitespace-nowrap` so the chip
 *      itself can grow as wide as its longest possible label
 *      ("Verbunden · vor 12 min" / "Error — reconnect"); the parent
 *      header is a `flex-wrap` so the pill drops to its own line if
 *      the title and pill together exceed the card width — this spec
 *      verifies neither path leaks into a horizontal scrollbar on the
 *      <html> element.
 *
 *   2. Render exactly one pill per integration card. Belt-and-braces
 *      guard for the card consolidation — the Vitest spec covers this
 *      on the SSR markup level, but the Pixel-5 layout is what matters
 *      in practice.
 *
 * Mobile-only spec — desktop project skips it.
 */
test.describe("/settings/integrations Pixel-5 layout", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("Pixel-5 viewport: no horizontal page scroll, one pill per card", async ({
    page,
  }) => {
    // Stub the three endpoints the Integrations section reads — both
    // integrations connected, recent sync — so the cards render their
    // post-connect branch (the visually densest layout).
    await page.route("**/api/settings/global-services", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            telegramGlobal: true,
            ntfyGlobal: true,
            webPushGlobal: true,
            apiGlobal: true,
            moodLogGlobal: true,
          },
          error: null,
        }),
      }),
    );

    const recent = new Date(Date.now() - 12 * 60 * 1000).toISOString();

    await page.route("**/api/integrations/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            threshold: 3,
            integrations: [
              {
                integration: "withings",
                state: "connected",
                lastSuccessAt: recent,
                lastAttemptAt: recent,
                lastError: null,
                consecutiveFailures: 0,
                // v1.12.1 — the cards read connection state from this
                // consolidated envelope (the per-provider routes were
                // dropped from the section). The Withings pill keys on
                // `connected`; the moodLog pill keys on `configured`.
                configured: true,
                connected: true,
                connectedAt: "2026-04-01T12:00:00Z",
                legacyLastSyncedAt: recent,
                tokenExpiresAt: "2026-12-01T12:00:00Z",
                tokenExpired: false,
                scope: "user.info,user.metrics,user.activity",
                hasActivityScope: true,
              },
              {
                integration: "moodlog",
                state: "connected",
                lastSuccessAt: recent,
                lastAttemptAt: recent,
                lastError: null,
                consecutiveFailures: 0,
                configured: true,
                enabled: true,
                legacyLastSyncedAt: recent,
                webhookSecret: "ml_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                entryCount: 42,
              },
              // v1.28.x — Strava OAuth card reads off this consolidated
              // envelope; without a `strava` entry the new card's query key
              // never resolves and the integrations page hangs.
              {
                integration: "strava",
                state: "disconnected",
                lastSuccessAt: null,
                lastAttemptAt: null,
                lastError: null,
                connected: false,
                configured: false,
                available: false,
                hasOwnCredentials: false,
              },
            ],
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/withings/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            connected: true,
            configured: true,
            lastSyncedAt: recent,
            connectedAt: "2026-04-01T12:00:00Z",
            tokenExpired: false,
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/integrations/moodlog/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            configured: true,
            enabled: true,
            lastSyncedAt: recent,
            entryCount: 42,
            webhookSecret: "ml_xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/integrations", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");

    // Wait for the pills to mount (queries resolve after first paint).
    // One pill per card: Withings, WHOOP, Fitbit, Google Health, Polar,
    // Oura, Strava, Nightscout. (The Garmin info note is not an OAuth card and
    // carries no pill.)
    const pills = page.locator('[data-testid="integration-status-pill"]');
    await expect(pills).toHaveCount(8, { timeout: 10_000 });

    // Withings is connected in this fixture; WHOOP is a BYO-keys card that
    // stays dormant until an operator adds credentials, so assert the one
    // connected pill.
    await expect(
      page.locator(
        '[data-testid="integration-status-pill"][data-state="connected"]',
      ),
    ).toHaveCount(1);

    // The redundant v1.4.18 banner must be gone.
    await expect(
      page.locator('[data-testid="integration-status-banner"]'),
    ).toHaveCount(0);

    // No horizontal page overflow. We allow a 1 px tolerance because
    // sub-pixel rounding can flag a 0.5 px overshoot as 1 px.
    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      dims.scrollWidth,
      `scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
    ).toBeLessThanOrEqual(dims.innerWidth + 1);

    // Pill text remains legible at this viewport — assert non-empty
    // bounding rect so we know it's painted, not display:none-d by
    // some surprising container query.
    for (let i = 0; i < 2; i++) {
      const box = await pills.nth(i).boundingBox();
      expect(box, `pill ${i} has no bounding box`).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });
});

test.describe("Apple Health guidance", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens on Integrations and reaches the one-shot import fallback", async ({
    page,
  }) => {
    await page.route("**/api/integrations/healthkit", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], lastSyncedAt: null },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/integrations");

    const card = page.getByTestId("apple-health-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("HealthLog iOS app");
    await expect(card).toContainText("not a web or OAuth connection");
    await expect(page.getByTestId("apple-health-status")).toHaveAttribute(
      "data-state",
      "setup",
    );

    const importLink = page.getByTestId("apple-health-import-link");
    await expect(importLink).toHaveAttribute(
      "href",
      "/settings/export#settings-section-import-title",
    );
    await page.goto("/settings/export#settings-section-import-title");
    await expect(page).toHaveURL(
      /\/settings\/export#settings-section-import-title$/,
    );
    await expect(page.getByTestId("import-card-apple-health")).toBeVisible();
  });
});
